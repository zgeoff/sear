import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import invariant from 'tiny-invariant';
import type {
  AgentStream,
  CancelAgentCommand,
  CancelPlannerCommand,
  CIStatusResult,
  DispatchImplementorCommand,
  DispatchReviewerCommand,
  Engine,
  EngineCommand,
  EngineConfig,
  EngineEvent,
  IssueDetailsResult,
  PRDetailsResult,
  PRFileEntry,
  PRReviewsResult,
  ShutdownCommand,
  SpecChange,
  StartupResult,
} from '../types.ts';
import { createBashValidatorHook } from './agent-manager/bash-validator/create-bash-validator-hook.ts';
import { buildImplementorTriggerPrompt } from './agent-manager/build-implementor-trigger-prompt.ts';
import { buildQueryFactory } from './agent-manager/build-query-factory.ts';
import { buildReviewerTriggerPrompt } from './agent-manager/build-reviewer-trigger-prompt.ts';
import { createAgentManager } from './agent-manager/create-agent-manager.ts';
import type { AgentManager, QueryFactory } from './agent-manager/types.ts';
import { createCommandDispatcher } from './command-dispatcher/create-command-dispatcher.ts';
import { buildResolvedConfig } from './config/build-resolved-config.ts';
import type { ResolvedEngineConfig } from './config/types.ts';
import type { Logger } from './create-logger.ts';
import { createLogger } from './create-logger.ts';
import { createDispatch } from './dispatch/create-dispatch.ts';
import type { Dispatch } from './dispatch/types.ts';
import { createEventEmitter } from './event-emitter/create-event-emitter.ts';
import type { EventEmitter } from './event-emitter/types.ts';
import { createGitHubClient } from './github-client/create-github-client.ts';
import type { GitHubClient } from './github-client/types.ts';
import { createPlannerCache } from './planner-cache/create-planner-cache.ts';
import type { PlannerCache } from './planner-cache/types.ts';
import { createIssuePoller } from './pollers/create-issue-poller.ts';
import { createPRPoller } from './pollers/create-pr-poller.ts';
import { createSpecPoller } from './pollers/create-spec-poller.ts';
import type { IssuePoller, PRCIStatus, PRPoller, SpecPollerSnapshot } from './pollers/types.ts';
import { getCIStatus } from './queries/get-ci-status.ts';
import { getIssueDetails } from './queries/get-issue-details.ts';
import { getPRFiles } from './queries/get-pr-files.ts';
import { buildClosingKeywordPattern, getPRForIssue } from './queries/get-pr-for-issue.ts';
import { getPRReviews } from './queries/get-pr-reviews.ts';
import type { QueriesConfig } from './queries/types.ts';
import { createRecovery } from './recovery/create-recovery.ts';
import type { IssuePollerSnapshot, IssueSnapshotEntry, Recovery } from './recovery/types.ts';
import { createWorktreeManager } from './worktree-manager/create-worktree-manager.ts';
import type { WorktreeManager } from './worktree-manager/types.ts';

interface EngineDeps {
  octokit?: GitHubClient;
  queryFactory?: QueryFactory;
  repoRoot?: string;
  worktreeManager?: WorktreeManager;
  execCommand?: (cwd: string, command: string, args: string[]) => Promise<void>;
}

interface PollerTimers {
  issueTimer: ReturnType<typeof setInterval> | null;
  specTimer: ReturnType<typeof setInterval> | null;
  prPollerTimer: ReturnType<typeof setInterval> | null;
}

const SECONDS_TO_MS = 1000;
const SHUTDOWN_CHECK_INTERVAL_MS = 1000;

const execFileAsync: (
  file: string,
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string; stderr: string }> = promisify(execFile);

export function createEngine(config: EngineConfig, deps?: EngineDeps): Engine {
  const resolved = buildResolvedConfig(config);
  const [owner = '', repo = ''] = resolved.repository.split('/');
  const logger = createLogger(resolved);
  const repoRoot = deps?.repoRoot ?? resolveRepoRoot();

  const octokit = deps?.octokit ?? buildGitHubClient(resolved);

  const emitter = createEventEmitter();
  const recovery = createRecovery({ octokit, owner, repo, emitter });
  const worktreeManager = deps?.worktreeManager ?? createWorktreeManager({ repoRoot });
  const plannerCache = createPlannerCache({ repoRoot, logger });

  const issuePoller = createIssuePoller({
    octokit,
    owner,
    repo,
    emitter,
    logError: (message: string, error: unknown): void =>
      logger.error(message, { error: String(error) }),
  });

  // SpecPoller is created without initialSnapshot here. During start(), if a
  // valid cache exists, the specPoller is re-created with the cached snapshot.
  let specPoller = buildSpecPoller(resolved, octokit, logger);

  // Maps PR numbers to their linked issue numbers. Populated during onCIStatusChanged
  // so that onPRRemoved can resolve the linked issue even after the PR is removed
  // from the PR Poller snapshot.
  const prToIssueMap = new Map<number, number>();

  // Holds the SpecPoller snapshot and commitSHA captured at Planner dispatch time.
  // Written to the cache file when the Planner completes successfully.
  let pendingCacheSnapshot: SpecPollerSnapshot | null = null;
  let pendingCacheCommitSHA: string | null = null;

  // Tracks the commitSHA from the latest SpecPollerBatchResult. Captured into
  // pendingCacheCommitSHA when the Planner is dispatched.
  let latestSpecCommitSHA = '';

  // Tracks the commitSHA from the most recently completed Planner run (via the cache).
  // Used as the base commit for computing spec diffs at planner dispatch time.
  let previousPlannerCommitSHA = '';

  // Tracks the change type (added/modified) for each spec path from the latest SpecPoller result.
  // Used to determine whether to compute diffs for each spec at planner dispatch time.
  const latestSpecChangeTypes = new Map<string, 'added' | 'modified'>();

  const prPoller = createPRPoller({
    gitHubClient: octokit,
    owner,
    repo,
    pollInterval: resolved.prPoller.pollInterval,
    onCIStatusChanged(
      prNumber: number,
      oldCIStatus: PRCIStatus | null,
      newCIStatus: PRCIStatus,
    ): void {
      try {
        handleCIStatusChanged({
          prNumber,
          oldCIStatus,
          newCIStatus,
          prPoller,
          issuePoller,
          emitter,
          prToIssueMap,
          logger,
        });
      } catch (error) {
        logger.error('onCIStatusChanged callback failed', { prNumber, error: String(error) });
      }
    },
    onPRDetected(prNumber: number): void {
      try {
        handlePRDetected({
          prNumber,
          prPoller,
          issuePoller,
          emitter,
          logger,
        });
      } catch (error) {
        logger.error('onPRDetected callback failed', { prNumber, error: String(error) });
      }
    },
    onPRRemoved(prNumber: number): void {
      try {
        handlePRRemoved({
          prNumber,
          prToIssueMap,
          logger,
        });
      } catch (error) {
        logger.error('onPRRemoved callback failed', { prNumber, error: String(error) });
      }
    },
  });

  const agentManager = createAgentManager({
    emitter,
    worktreeManager,
    repoRoot,
    agentPlanner: resolved.agents.agentPlanner,
    agentImplementor: resolved.agents.agentImplementor,
    agentReviewer: resolved.agents.agentReviewer,
    maxAgentDuration: resolved.agents.maxAgentDuration,
    queryFactory:
      deps?.queryFactory ??
      buildQueryFactory({
        repoRoot,
        bashValidatorHook: createBashValidatorHook(),
        contextPaths: ['.claude/CLAUDE.md'],
      }),
    loggingEnabled: resolved.logging.agentSessions,
    logsDir: resolved.logging.logsDir,
    logError: (message: string, error: unknown): void =>
      logger.error(message, { error: String(error) }),
    logInfo: (message: string): void => logger.info(message),
    execCommand:
      deps?.execCommand ??
      (async (cwd: string, command: string, args: string[]): Promise<void> => {
        await execFileAsync(command, args, { cwd });
      }),
  });

  const dispatch = createDispatch(
    emitter,
    {
      dispatchPlanner: async (specPaths: string[]): Promise<void> => {
        pendingCacheSnapshot = specPoller.getSnapshot();
        pendingCacheCommitSHA = latestSpecCommitSHA;

        try {
          const prompt = await buildPlannerPrompt({
            specPaths,
            octokit,
            owner,
            repo,
            currentCommitSHA: latestSpecCommitSHA,
            previousCommitSHA: previousPlannerCommitSHA,
            latestSpecChangeTypes,
            repoRoot,
          });
          await agentManager.dispatchPlanner({ specPaths, prompt });
        } catch (error) {
          logger.error('Failed to build planner context', { error: String(error) });
          pendingCacheSnapshot = null;
          pendingCacheCommitSHA = null;
          dispatch.handlePlannerFailed(specPaths);
        }
      },
      isPlannerRunning: (): boolean => agentManager.isPlannerRunning(),
    },
    { repository: resolved.repository },
  );

  const queriesConfig: QueriesConfig = { octokit, owner, repo };

  const pollerTimers: PollerTimers = {
    issueTimer: null,
    specTimer: null,
    prPollerTimer: null,
  };

  const commandDispatcher = createCommandDispatcher({
    async dispatchImplementor(command: DispatchImplementorCommand): Promise<void> {
      await handleDispatchImplementor({
        issueNumber: command.issueNumber,
        issuePoller,
        agentManager,
        queriesConfig,
        logger,
      });
    },
    async dispatchReviewer(command: DispatchReviewerCommand): Promise<void> {
      await handleDispatchReviewer({
        issueNumber: command.issueNumber,
        issuePoller,
        agentManager,
        queriesConfig,
        logger,
      });
    },
    async cancelAgent(command: CancelAgentCommand): Promise<void> {
      try {
        await agentManager.cancelAgent(command.issueNumber);
      } catch (error) {
        logger.error('Failed to cancel agent', {
          issueNumber: command.issueNumber,
          error: String(error),
        });
      }
    },
    async cancelPlanner(_command: CancelPlannerCommand): Promise<void> {
      try {
        await agentManager.cancelPlanner();
      } catch (error) {
        logger.error('Failed to cancel planner', { error: String(error) });
      }
    },
    shutdown(_command: ShutdownCommand): void {
      initiateShutdown({
        config: resolved,
        logger,
        agentManager,
        pollerTimers,
        prPoller,
      });
    },
  });

  return {
    // Resolves after planner cache load, startup recovery, and first IssuePoller, SpecPoller, and PR Poller cycles complete
    async start(): Promise<StartupResult> {
      logger.info('Engine starting', {
        repository: resolved.repository,
        logLevel: resolved.logLevel,
        issuePollInterval: resolved.issuePoller.pollInterval,
        specPollInterval: resolved.specPoller.pollInterval,
        prPollInterval: resolved.prPoller.pollInterval,
      });

      // Step 1: Wire event handler before any events are emitted
      const eventHandler = buildEventHandler({
        emitter,
        agentManager,
        recovery,
        issuePoller,
        dispatch,
        plannerCache,
        getPendingCacheSnapshot: (): SpecPollerSnapshot | null => pendingCacheSnapshot,
        getPendingCacheCommitSHA: (): string | null => pendingCacheCommitSHA,
        clearPendingCache: (): void => {
          pendingCacheSnapshot = null;
          pendingCacheCommitSHA = null;
        },
        onPlannerCacheWritten: (commitSHA: string): void => {
          previousPlannerCommitSHA = commitSHA;
        },
        queriesConfig,
        logger,
      });
      emitter.on(eventHandler);

      // Step 2: Load planner cache (before recovery and before pollers)
      const cachedEntry = await plannerCache.load();
      if (cachedEntry) {
        specPoller = buildSpecPoller(resolved, octokit, logger, cachedEntry.snapshot);
        latestSpecCommitSHA = cachedEntry.commitSHA;
        previousPlannerCommitSHA = cachedEntry.commitSHA;
      }

      // Step 3: Startup recovery
      const recoveryResult = await recovery.performStartupRecovery();

      // Step 4: First IssuePoller cycle
      await issuePoller.poll();

      // Step 5: First SpecPoller cycle
      const specResult = await specPoller.poll();
      latestSpecCommitSHA = specResult.commitSHA;
      trackSpecChangeTypes(specResult.changes, latestSpecChangeTypes);
      await dispatch.handleSpecPollerResult(specResult);

      // Step 6: First PR Poller cycle (direct invocation, awaited before start() resolves)
      await prPoller.poll();

      // Step 7: Start recurring poll timers
      pollerTimers.issueTimer = setInterval(async () => {
        logger.debug('IssuePoller cycle starting');
        await issuePoller.poll();
      }, resolved.issuePoller.pollInterval * SECONDS_TO_MS);

      pollerTimers.specTimer = setInterval(async () => {
        logger.debug('SpecPoller cycle starting');
        const result = await specPoller.poll();
        latestSpecCommitSHA = result.commitSHA;
        trackSpecChangeTypes(result.changes, latestSpecChangeTypes);
        await dispatch.handleSpecPollerResult(result);
      }, resolved.specPoller.pollInterval * SECONDS_TO_MS);

      pollerTimers.prPollerTimer = setInterval(async () => {
        logger.debug('PRPoller cycle starting');
        await prPoller.poll();
      }, resolved.prPoller.pollInterval * SECONDS_TO_MS);

      const issueCount = issuePoller.getSnapshot().size;

      logger.info('Engine started', {
        issueCount,
        recoveriesPerformed: recoveryResult.recoveriesPerformed,
      });

      return {
        issueCount,
        recoveriesPerformed: recoveryResult.recoveriesPerformed,
      };
    },

    on(handler: (event: EngineEvent) => void): () => void {
      return emitter.on(handler);
    },

    send(command: EngineCommand): void {
      commandDispatcher.dispatch(command);
    },

    getIssueDetails(issueNumber: number): Promise<IssueDetailsResult> {
      return getIssueDetails(queriesConfig, issueNumber);
    },

    getPRForIssue(
      issueNumber: number,
      options?: { includeDrafts?: boolean },
    ): Promise<PRDetailsResult> {
      return getPRForIssue(queriesConfig, issueNumber, options);
    },

    getPRFiles(prNumber: number): Promise<PRFileEntry[]> {
      return getPRFiles(queriesConfig, prNumber);
    },

    getPRReviews(prNumber: number): Promise<PRReviewsResult> {
      return getPRReviews(queriesConfig, prNumber);
    },

    getCIStatus(prNumber: number): Promise<CIStatusResult> {
      return getCIStatus(queriesConfig, prNumber);
    },

    getAgentStream(sessionID: string): AgentStream {
      return agentManager.getAgentStream(sessionID);
    },
  };
}

// ---------------------------------------------------------------------------
// Event handler (wires poller events to dispatch, agent cancellation, recovery)
// ---------------------------------------------------------------------------

interface EventHandlerDeps {
  emitter: EventEmitter;
  agentManager: AgentManager;
  recovery: Recovery;
  issuePoller: IssuePoller;
  dispatch: Dispatch;
  plannerCache: PlannerCache;
  getPendingCacheSnapshot: () => SpecPollerSnapshot | null;
  getPendingCacheCommitSHA: () => string | null;
  clearPendingCache: () => void;
  onPlannerCacheWritten: (commitSHA: string) => void;
  queriesConfig: QueriesConfig;
  logger: Logger;
}

function buildEventHandler(deps: EventHandlerDeps): (event: EngineEvent) => Promise<void> {
  return async (event: EngineEvent): Promise<void> => {
    if (event.type === 'issueStatusChanged') {
      await deps.dispatch.handleIssueStatusChanged(event);
    }

    if (
      event.type === 'issueStatusChanged' &&
      event.newStatus === null &&
      deps.agentManager.isRunning(event.issueNumber)
    ) {
      await deps.agentManager.cancelAgent(event.issueNumber);
    }

    if (event.type === 'agentCompleted' && event.agentType === 'planner') {
      await handlePlannerCompleted(deps);
    }

    if (event.type === 'agentFailed' && event.agentType === 'planner') {
      deps.clearPendingCache();
    }

    if (
      event.type === 'agentFailed' &&
      event.agentType === 'planner' &&
      event.specPaths !== undefined
    ) {
      deps.dispatch.handlePlannerFailed(event.specPaths);
    }

    // Completion-dispatch: when an Implementor completes, check for a linked non-draft PR
    // and dispatch a Reviewer if found. This runs before crash recovery so the snapshot
    // is updated to status:review before recovery checks (preventing a spurious reset).
    if (
      event.type === 'agentCompleted' &&
      event.agentType === 'implementor' &&
      event.issueNumber !== undefined
    ) {
      await handleImplementorCompleted(event.issueNumber, deps);
    }

    if (
      (event.type === 'agentCompleted' || event.type === 'agentFailed') &&
      event.issueNumber !== undefined
    ) {
      const snapshotAdapter = buildSnapshotAdapter(deps.issuePoller);

      try {
        await deps.recovery.performCrashRecovery({
          agentType: event.agentType,
          issueNumber: event.issueNumber,
          snapshot: snapshotAdapter,
        });
      } catch (error) {
        deps.logger.error('Crash recovery failed', {
          issueNumber: event.issueNumber,
          error: String(error),
        });
      }
    }
  };
}

async function handlePlannerCompleted(deps: EventHandlerDeps): Promise<void> {
  const snapshot = deps.getPendingCacheSnapshot();
  const commitSHA = deps.getPendingCacheCommitSHA();
  deps.clearPendingCache();

  if (!(snapshot && commitSHA)) {
    return;
  }

  try {
    await deps.plannerCache.write(snapshot, commitSHA);
    deps.onPlannerCacheWritten(commitSHA);
  } catch (error) {
    deps.logger.error('Failed to write planner cache', {
      error: String(error),
    });
  }
}

async function handleImplementorCompleted(
  issueNumber: number,
  deps: EventHandlerDeps,
): Promise<void> {
  try {
    const prDetails = await getPRForIssue(deps.queriesConfig, issueNumber, {
      includeDrafts: false,
    });

    if (!prDetails) {
      return;
    }

    const { octokit, owner, repo } = deps.queriesConfig;

    // Set status:review on the issue via GitHub API
    await octokit.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: 'status:in-progress',
    });
    await octokit.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: ['status:review'],
    });

    // Update the IssuePoller snapshot to prevent a duplicate issueStatusChanged on the next poll
    deps.issuePoller.updateEntry(issueNumber, { statusLabel: 'review' });

    // Emit a synthetic issueStatusChanged with isEngineTransition: true
    const issueSnapshot = deps.issuePoller.getSnapshot().get(issueNumber);
    deps.emitter.emit({
      type: 'issueStatusChanged',
      issueNumber,
      title: issueSnapshot?.title ?? '',
      oldStatus: 'in-progress',
      newStatus: 'review',
      priorityLabel: issueSnapshot?.priorityLabel ?? '',
      createdAt: issueSnapshot?.createdAt ?? '',
      isEngineTransition: true,
    });

    // Build enriched prompt
    const [issueDetails, prFiles, prReviews] = await Promise.all([
      getIssueDetails(deps.queriesConfig, issueNumber),
      getPRFiles(deps.queriesConfig, prDetails.number),
      getPRReviews(deps.queriesConfig, prDetails.number),
    ]);

    const prompt = buildReviewerTriggerPrompt({
      issueDetails,
      prNumber: prDetails.number,
      prTitle: prDetails.title,
      prFiles,
      prReviews,
    });

    // Dispatch the Reviewer
    await deps.agentManager.dispatchReviewer({
      issueNumber,
      branchName: prDetails.headRefName,
      fetchRemote: true,
      prompt,
    });
  } catch (error) {
    deps.logger.error('Completion-dispatch failed', {
      issueNumber,
      error: String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Snapshot adapter
// ---------------------------------------------------------------------------

// The IssuePoller exposes getSnapshot() returning ReadonlyMap for read-only
// consumers. The Recovery module needs IssuePollerSnapshot with get/set, so this
// adapter uses getSnapshotMap() which returns the underlying mutable Map.
function buildSnapshotAdapter(issuePoller: IssuePoller): IssuePollerSnapshot {
  return {
    get(issueNumber: number): IssueSnapshotEntry | undefined {
      return issuePoller.getSnapshot().get(issueNumber);
    },
    set(issueNumber: number, entry: IssueSnapshotEntry): void {
      issuePoller.getSnapshotMap().set(issueNumber, entry);
    },
  };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

const USER_DISPATCH_STATUSES: Set<string> = new Set(['pending', 'unblocked', 'needs-changes']);

const COMPLEXITY_MODEL_OVERRIDES: Record<string, 'sonnet' | 'opus'> = {
  'complexity:simple': 'sonnet',
  'complexity:complex': 'opus',
};

interface HandleDispatchImplementorParams {
  issueNumber: number;
  issuePoller: IssuePoller;
  agentManager: AgentManager;
  queriesConfig: QueriesConfig;
  logger: Logger;
}

async function handleDispatchImplementor(params: HandleDispatchImplementorParams): Promise<void> {
  const issue = params.issuePoller.getSnapshot().get(params.issueNumber);

  if (!issue) {
    return;
  }

  const isUserDispatchStatus = USER_DISPATCH_STATUSES.has(issue.statusLabel);
  const isInProgress = issue.statusLabel === 'in-progress';

  if (!(isUserDispatchStatus || isInProgress)) {
    return;
  }

  const modelOverride = COMPLEXITY_MODEL_OVERRIDES[issue.complexityLabel];

  try {
    const prDetails = await getPRForIssue(params.queriesConfig, params.issueNumber, {
      includeDrafts: true,
    });
    const branchStrategy = buildBranchStrategy(params.issueNumber, prDetails);

    const prompt = prDetails
      ? await buildImplementorPromptWithPR(params, prDetails)
      : await buildImplementorPromptWithoutPR(params);

    await params.agentManager.dispatchImplementor({
      issueNumber: params.issueNumber,
      branchName: branchStrategy.branchName,
      ...(branchStrategy.branchBase !== undefined && { branchBase: branchStrategy.branchBase }),
      ...(modelOverride !== undefined && { modelOverride }),
      prompt,
    });
  } catch (error) {
    params.logger.error('Failed to dispatch implementor', {
      issueNumber: params.issueNumber,
      error: String(error),
    });
  }
}

interface HandleDispatchReviewerParams {
  issueNumber: number;
  issuePoller: IssuePoller;
  agentManager: AgentManager;
  queriesConfig: QueriesConfig;
  logger: Logger;
}

async function handleDispatchReviewer(params: HandleDispatchReviewerParams): Promise<void> {
  const issue = params.issuePoller.getSnapshot().get(params.issueNumber);

  if (!issue) {
    return;
  }
  if (issue.statusLabel !== 'review') {
    return;
  }

  try {
    const prDetails = await getPRForIssue(params.queriesConfig, params.issueNumber, {
      includeDrafts: false,
    });

    if (!prDetails) {
      params.logger.info('Cannot dispatch reviewer — no PR found for issue', {
        issueNumber: params.issueNumber,
      });
      return;
    }

    const [issueDetails, prFiles, prReviews] = await Promise.all([
      getIssueDetails(params.queriesConfig, params.issueNumber),
      getPRFiles(params.queriesConfig, prDetails.number),
      getPRReviews(params.queriesConfig, prDetails.number),
    ]);

    const prompt = buildReviewerTriggerPrompt({
      issueDetails,
      prNumber: prDetails.number,
      prTitle: prDetails.title,
      prFiles,
      prReviews,
    });

    await params.agentManager.dispatchReviewer({
      issueNumber: params.issueNumber,
      branchName: prDetails.headRefName,
      fetchRemote: true,
      prompt,
    });
  } catch (error) {
    params.logger.error('Failed to dispatch reviewer', {
      issueNumber: params.issueNumber,
      error: String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Implementor context pre-computation
// ---------------------------------------------------------------------------

async function buildImplementorPromptWithPR(
  params: HandleDispatchImplementorParams,
  prDetails: NonNullable<PRDetailsResult>,
): Promise<string> {
  const [issueDetails, prFiles, prReviews, ciStatus] = await Promise.all([
    getIssueDetails(params.queriesConfig, params.issueNumber),
    getPRFiles(params.queriesConfig, prDetails.number),
    getPRReviews(params.queriesConfig, prDetails.number),
    getCIStatus(params.queriesConfig, prDetails.number),
  ]);

  return buildImplementorTriggerPrompt({
    issueDetails,
    prNumber: prDetails.number,
    prTitle: prDetails.title,
    prFiles,
    prReviews,
    ciStatus,
  });
}

async function buildImplementorPromptWithoutPR(
  params: HandleDispatchImplementorParams,
): Promise<string> {
  const issueDetails = await getIssueDetails(params.queriesConfig, params.issueNumber);
  return buildImplementorTriggerPrompt({ issueDetails });
}

// ---------------------------------------------------------------------------
// Branch strategy
// ---------------------------------------------------------------------------

interface BranchStrategy {
  branchName: string;
  branchBase?: string;
}

function buildBranchStrategy(issueNumber: number, prDetails: PRDetailsResult): BranchStrategy {
  if (prDetails) {
    // PR-branch strategy: resume on existing PR branch
    return { branchName: prDetails.headRefName };
  }

  // Fresh-branch strategy: new branch from main with timestamp for uniqueness
  const timestamp = Date.now();
  return {
    branchName: `issue-${issueNumber}-${timestamp}`,
    branchBase: 'main',
  };
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

interface InitiateShutdownParams {
  config: ResolvedEngineConfig;
  logger: Logger;
  agentManager: AgentManager;
  pollerTimers: PollerTimers;
  prPoller: PRPoller;
}

function initiateShutdown(params: InitiateShutdownParams): void {
  params.logger.info('Shutdown initiated');

  if (params.pollerTimers.issueTimer) {
    clearInterval(params.pollerTimers.issueTimer);
    params.pollerTimers.issueTimer = null;
  }
  if (params.pollerTimers.specTimer) {
    clearInterval(params.pollerTimers.specTimer);
    params.pollerTimers.specTimer = null;
  }
  if (params.pollerTimers.prPollerTimer) {
    clearInterval(params.pollerTimers.prPollerTimer);
    params.pollerTimers.prPollerTimer = null;
  }
  params.prPoller.stop();

  const runningCount = params.agentManager.getRunningSessionIDs().length;

  if (runningCount === 0) {
    params.logger.info('Shutdown complete', { agentsTerminated: 0 });
    return;
  }

  const shutdownTimer = setTimeout(async () => {
    clearInterval(checkInterval);
    try {
      await params.agentManager.cancelAll();
    } catch (error) {
      params.logger.error('Failed to cancel all agents during shutdown', {
        error: String(error),
      });
    }
    params.logger.info('Shutdown complete', { agentsTerminated: runningCount });
  }, params.config.shutdownTimeout * SECONDS_TO_MS);

  const checkInterval = setInterval(() => {
    const remaining = params.agentManager.getRunningSessionIDs().length;
    if (remaining === 0) {
      clearInterval(checkInterval);
      clearTimeout(shutdownTimer);
      params.logger.info('Shutdown complete', { agentsTerminated: 0 });
    }
  }, SHUTDOWN_CHECK_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// GitHub client factory (reads private key from disk, delegates to adapter)
// ---------------------------------------------------------------------------

function buildGitHubClient(config: ResolvedEngineConfig): GitHubClient {
  const privateKey = readFileSync(config.githubAppPrivateKeyPath, 'utf-8');
  return createGitHubClient({
    appID: config.githubAppID,
    privateKey,
    installationID: config.githubAppInstallationID,
  });
}

// ---------------------------------------------------------------------------
// Repository root resolution
// ---------------------------------------------------------------------------

function resolveRepoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}

// ---------------------------------------------------------------------------
// SpecPoller factory (supports optional initial snapshot from cache)
// ---------------------------------------------------------------------------

function buildSpecPoller(
  config: ResolvedEngineConfig,
  octokit: GitHubClient,
  logger: Logger,
  initialSnapshot?: SpecPollerSnapshot,
): ReturnType<typeof createSpecPoller> {
  const baseConfig = {
    octokit,
    owner: config.repository.split('/')[0] ?? '',
    repo: config.repository.split('/')[1] ?? '',
    specsDir: config.specPoller.specsDir,
    defaultBranch: config.specPoller.defaultBranch,
    logError: (message: string, error: unknown): void =>
      logger.error(message, { error: String(error) }),
  };

  if (initialSnapshot) {
    return createSpecPoller({ ...baseConfig, initialSnapshot });
  }

  return createSpecPoller(baseConfig);
}

// ---------------------------------------------------------------------------
// Spec change type tracking
// ---------------------------------------------------------------------------

function trackSpecChangeTypes(
  changes: SpecChange[],
  changeTypes: Map<string, 'added' | 'modified'>,
): void {
  for (const change of changes) {
    changeTypes.set(change.filePath, change.changeType);
  }
}

// ---------------------------------------------------------------------------
// Planner context pre-computation
// ---------------------------------------------------------------------------

interface BuildPlannerPromptConfig {
  specPaths: string[];
  octokit: GitHubClient;
  owner: string;
  repo: string;
  currentCommitSHA: string;
  previousCommitSHA: string;
  latestSpecChangeTypes: Map<string, 'added' | 'modified'>;
  repoRoot: string;
}

interface ExistingIssue {
  number: number;
  title: string;
  labels: string[];
  body: string | null;
}

async function buildPlannerPrompt(config: BuildPlannerPromptConfig): Promise<string> {
  const specSections = await buildSpecSections(config);
  const issuesSection = await buildIssuesSection(config);

  const sections: string[] = [];
  sections.push('## Changed Specs');
  sections.push('');
  sections.push(specSections);
  sections.push('## Existing Open Issues');
  sections.push(issuesSection);

  return sections.join('\n');
}

async function buildSpecSections(config: BuildPlannerPromptConfig): Promise<string> {
  const specContents = await Promise.all(
    config.specPaths.map((specPath) => fetchSpecContent(config, specPath)),
  );

  const sections: string[] = [];

  for (let i = 0; i < config.specPaths.length; i += 1) {
    const specPath = config.specPaths[i];
    invariant(specPath, 'specPath must exist at index within bounds');
    const content = specContents[i] ?? '';
    const changeType = config.latestSpecChangeTypes.get(specPath) ?? 'added';

    sections.push(`### ${specPath} (${changeType})`);
    sections.push(content);
    sections.push('');

    if (changeType === 'modified' && config.previousCommitSHA) {
      const diff = computeSpecDiff(config, specPath);
      if (diff) {
        sections.push('#### Diff');
        sections.push(diff);
        sections.push('');
      }
    }
  }

  return sections.join('\n');
}

async function fetchSpecContent(
  config: BuildPlannerPromptConfig,
  specPath: string,
): Promise<string> {
  const result = await config.octokit.repos.getContent({
    owner: config.owner,
    repo: config.repo,
    path: specPath,
    ref: config.currentCommitSHA,
  });

  if (!result.data.content) {
    return '';
  }

  return Buffer.from(result.data.content, 'base64').toString('utf-8');
}

function computeSpecDiff(config: BuildPlannerPromptConfig, specPath: string): string {
  try {
    return execFileSync(
      'git',
      ['diff', `${config.previousCommitSHA}..${config.currentCommitSHA}`, '--', specPath],
      { encoding: 'utf-8', cwd: config.repoRoot },
    );
  } catch {
    // git diff may fail if the commits are not available locally. Skip the diff silently.
    return '';
  }
}

const PER_PAGE = 100;

async function buildIssuesSection(config: BuildPlannerPromptConfig): Promise<string> {
  // GitHub REST API labels parameter uses AND logic. To get issues with either
  // task:implement OR task:refinement, we make two parallel calls and deduplicate.
  const [implementResult, refinementResult] = await Promise.all([
    config.octokit.issues.listForRepo({
      owner: config.owner,
      repo: config.repo,
      labels: 'task:implement',
      state: 'open',
      per_page: PER_PAGE,
    }),
    config.octokit.issues.listForRepo({
      owner: config.owner,
      repo: config.repo,
      labels: 'task:refinement',
      state: 'open',
      per_page: PER_PAGE,
    }),
  ]);

  const seen = new Set<number>();
  const issues: ExistingIssue[] = [];

  for (const issue of [...implementResult.data, ...refinementResult.data]) {
    if (!seen.has(issue.number)) {
      seen.add(issue.number);
      issues.push({
        number: issue.number,
        title: issue.title,
        labels: extractLabelNames(issue.labels),
        body: issue.body,
      });
    }
  }

  return JSON.stringify(issues);
}

function extractLabelNames(labels: (string | { name?: string })[]): string[] {
  const names: string[] = [];
  for (const label of labels) {
    if (typeof label === 'string') {
      names.push(label);
    } else if (label.name) {
      names.push(label.name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// PR Poller callback handlers
// ---------------------------------------------------------------------------

interface HandleCIStatusChangedParams {
  prNumber: number;
  oldCIStatus: PRCIStatus | null;
  newCIStatus: PRCIStatus;
  prPoller: PRPoller;
  issuePoller: IssuePoller;
  emitter: EventEmitter;
  prToIssueMap: Map<number, number>;
  logger: Logger;
}

function handleCIStatusChanged(params: HandleCIStatusChangedParams): void {
  const issueNumber = resolveIssueForPR(params.prNumber, params.prPoller, params.issuePoller);

  // Maintain PR→issue mapping for use in onPRRemoved
  if (issueNumber !== undefined) {
    params.prToIssueMap.set(params.prNumber, issueNumber);
  }

  // Emit ciStatusChanged for every transition, regardless of issue linkage
  params.emitter.emit({
    type: 'ciStatusChanged',
    prNumber: params.prNumber,
    ...(issueNumber !== undefined && { issueNumber }),
    oldCIStatus: params.oldCIStatus,
    newCIStatus: params.newCIStatus,
  });

  if (issueNumber !== undefined) {
    params.logger.info('CI status changed', {
      prNumber: params.prNumber,
      oldCIStatus: params.oldCIStatus,
      newCIStatus: params.newCIStatus,
      issueNumber,
    });
  }
}

interface HandlePRRemovedParams {
  prNumber: number;
  prToIssueMap: Map<number, number>;
  logger: Logger;
}

function handlePRRemoved(params: HandlePRRemovedParams): void {
  const issueNumber = params.prToIssueMap.get(params.prNumber);

  params.logger.info('PR removed', { prNumber: params.prNumber, issueNumber });

  // Clean up the PR→issue mapping
  params.prToIssueMap.delete(params.prNumber);
}

interface HandlePRDetectedParams {
  prNumber: number;
  prPoller: PRPoller;
  issuePoller: IssuePoller;
  emitter: EventEmitter;
  logger: Logger;
}

function handlePRDetected(params: HandlePRDetectedParams): void {
  const issueNumber = resolveIssueForPR(params.prNumber, params.prPoller, params.issuePoller);

  if (issueNumber === undefined) {
    return;
  }

  const prEntry = params.prPoller.getSnapshot().get(params.prNumber);
  if (!prEntry) {
    return;
  }

  params.emitter.emit({
    type: 'prLinked',
    issueNumber,
    prNumber: params.prNumber,
    url: prEntry.url,
    ciStatus: prEntry.ciStatus,
  });

  params.logger.info('PR linked', {
    prNumber: params.prNumber,
    issueNumber,
    url: prEntry.url,
    ciStatus: prEntry.ciStatus,
  });
}

/**
 * Resolves a PR number to a tracked issue number using closing-keyword matching
 * on the PR body from the PR Poller snapshot.
 */
function resolveIssueForPR(
  prNumber: number,
  prPoller: PRPoller,
  issuePoller: IssuePoller,
): number | undefined {
  const prEntry = prPoller.getSnapshot().get(prNumber);
  if (!prEntry) {
    return;
  }

  const prBody = prEntry.body;
  if (!prBody) {
    return;
  }

  const issueSnapshot = issuePoller.getSnapshot();

  for (const [issueNumber] of issueSnapshot) {
    const pattern = buildClosingKeywordPattern(issueNumber);
    if (pattern.test(prBody)) {
      return issueNumber;
    }
  }

  return;
}
