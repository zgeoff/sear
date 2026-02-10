import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import invariant from 'tiny-invariant';
import type {
  AgentStream,
  CancelAgentCommand,
  CancelPlannerCommand,
  DispatchImplementorCommand,
  DispatchReviewerCommand,
  Engine,
  EngineCommand,
  EngineConfig,
  EngineEvent,
  IssueDetailsResult,
  PRDetailsResult,
  ShutdownCommand,
  SpecChange,
  StartupResult,
} from '../types.ts';
import { createBashValidatorHook } from './agent-manager/bash-validator/create-bash-validator-hook.ts';
import { buildQueryFactory } from './agent-manager/build-query-factory.ts';
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
import { createGitHubClient } from './github-client/create-github-client.ts';
import type { GitHubClient } from './github-client/types.ts';
import { createPlannerCache } from './planner-cache/create-planner-cache.ts';
import type { PlannerCache } from './planner-cache/types.ts';
import { createIssuePoller } from './pollers/create-issue-poller.ts';
import { createSpecPoller } from './pollers/create-spec-poller.ts';
import type { IssuePoller, SpecPollerSnapshot } from './pollers/types.ts';
import { getIssueDetails } from './queries/get-issue-details.ts';
import { getPRForIssue } from './queries/get-pr-for-issue.ts';
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
}

interface PollerTimers {
  issueTimer: ReturnType<typeof setInterval> | null;
  specTimer: ReturnType<typeof setInterval> | null;
}

const SECONDS_TO_MS = 1000;
const SHUTDOWN_CHECK_INTERVAL_MS = 1000;

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
      dispatchReviewer: async (issueNumber: number): Promise<void> => {
        await agentManager.dispatchReviewer({ issueNumber });
      },
      isPlannerRunning: (): boolean => agentManager.isPlannerRunning(),
    },
    { repository: resolved.repository },
  );

  const queriesConfig: QueriesConfig = { octokit, owner, repo };

  const pollerTimers: PollerTimers = {
    issueTimer: null,
    specTimer: null,
  };

  const commandDispatcher = createCommandDispatcher({
    async dispatchImplementor(command: DispatchImplementorCommand): Promise<void> {
      await handleDispatchImplementor(command.issueNumber, issuePoller, agentManager, logger);
    },
    async dispatchReviewer(command: DispatchReviewerCommand): Promise<void> {
      await handleDispatchReviewer(command.issueNumber, issuePoller, agentManager, logger);
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
      initiateShutdown(resolved, logger, agentManager, pollerTimers);
    },
  });

  return {
    async start(): Promise<StartupResult> {
      logger.info('Engine starting', {
        repository: resolved.repository,
        logLevel: resolved.logLevel,
        issuePollInterval: resolved.issuePoller.pollInterval,
        specPollInterval: resolved.specPoller.pollInterval,
      });

      // Step 1: Wire event handler before any events are emitted
      const eventHandler = buildEventHandler({
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

      // Step 6: Start recurring poll timers
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

    getPRForIssue(issueNumber: number): Promise<PRDetailsResult> {
      return getPRForIssue(queriesConfig, issueNumber);
    },

    getAgentStream(issueNumber: number): AgentStream {
      return agentManager.getAgentStream(issueNumber);
    },
  };
}

// ---------------------------------------------------------------------------
// Event handler (wires poller events to dispatch, agent cancellation, recovery)
// ---------------------------------------------------------------------------

interface EventHandlerDeps {
  agentManager: AgentManager;
  recovery: Recovery;
  issuePoller: IssuePoller;
  dispatch: Dispatch;
  plannerCache: PlannerCache;
  getPendingCacheSnapshot: () => SpecPollerSnapshot | null;
  getPendingCacheCommitSHA: () => string | null;
  clearPendingCache: () => void;
  onPlannerCacheWritten: (commitSHA: string) => void;
  logger: Logger;
}

function buildEventHandler(deps: EventHandlerDeps): (event: EngineEvent) => Promise<void> {
  return async (event: EngineEvent): Promise<void> => {
    if (event.type === 'issueStatusChanged') {
      await deps.dispatch.handleIssueStatusChanged(event);
    }

    if (event.type === 'issueRemoved' && deps.agentManager.isRunning(event.issueNumber)) {
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

async function handleDispatchImplementor(
  issueNumber: number,
  issuePoller: IssuePoller,
  agentManager: AgentManager,
  logger: Logger,
): Promise<void> {
  const issue = issuePoller.getSnapshot().get(issueNumber);

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
    await agentManager.dispatchImplementor({
      issueNumber,
      ...(modelOverride !== undefined && { modelOverride }),
    });
  } catch (error) {
    logger.error('Failed to dispatch implementor', {
      issueNumber,
      error: String(error),
    });
  }
}

async function handleDispatchReviewer(
  issueNumber: number,
  issuePoller: IssuePoller,
  agentManager: AgentManager,
  logger: Logger,
): Promise<void> {
  const issue = issuePoller.getSnapshot().get(issueNumber);

  if (!issue) {
    return;
  }
  if (issue.statusLabel !== 'review') {
    return;
  }

  try {
    await agentManager.dispatchReviewer({ issueNumber });
  } catch (error) {
    logger.error('Failed to dispatch reviewer', {
      issueNumber,
      error: String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

function initiateShutdown(
  config: ResolvedEngineConfig,
  logger: Logger,
  agentManager: AgentManager,
  pollerTimers: PollerTimers,
): void {
  logger.info('Shutdown initiated');

  if (pollerTimers.issueTimer) {
    clearInterval(pollerTimers.issueTimer);
    pollerTimers.issueTimer = null;
  }
  if (pollerTimers.specTimer) {
    clearInterval(pollerTimers.specTimer);
    pollerTimers.specTimer = null;
  }

  const runningCount = agentManager.getRunningSessionIDs().length;

  if (runningCount === 0) {
    logger.info('Shutdown complete', { agentsTerminated: 0 });
    return;
  }

  const shutdownTimer = setTimeout(async () => {
    clearInterval(checkInterval);
    try {
      await agentManager.cancelAll();
    } catch (error) {
      logger.error('Failed to cancel all agents during shutdown', { error: String(error) });
    }
    logger.info('Shutdown complete', { agentsTerminated: runningCount });
  }, config.shutdownTimeout * SECONDS_TO_MS);

  const checkInterval = setInterval(() => {
    const remaining = agentManager.getRunningSessionIDs().length;
    if (remaining === 0) {
      clearInterval(checkInterval);
      clearTimeout(shutdownTimer);
      logger.info('Shutdown complete', { agentsTerminated: 0 });
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
