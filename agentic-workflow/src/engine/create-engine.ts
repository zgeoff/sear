import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
import { createIssuePoller } from './pollers/create-issue-poller.ts';
import { createSpecPoller } from './pollers/create-spec-poller.ts';
import type { IssuePoller, IssueSnapshot } from './pollers/types.ts';
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

  const issuePoller = createIssuePoller({
    octokit,
    owner,
    repo,
    emitter,
    logError: (message: string, error: unknown): void =>
      logger.error(message, { error: String(error) }),
  });

  const specPoller = createSpecPoller({
    octokit,
    owner,
    repo,
    specsDir: resolved.specPoller.specsDir,
    defaultBranch: resolved.specPoller.defaultBranch,
    logError: (message: string, error: unknown): void =>
      logger.error(message, { error: String(error) }),
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
      buildQueryFactory({ repoRoot, bashValidatorHook: createBashValidatorHook() }),
    loggingEnabled: resolved.logging.agentSessions,
    logsDir: resolved.logging.logsDir,
    logError: (message: string, error: unknown): void =>
      logger.error(message, { error: String(error) }),
  });

  const dispatch = createDispatch(
    emitter,
    {
      dispatchPlanner: (specPaths: string[]): void => {
        void agentManager.dispatchPlanner({ specPaths });
      },
      dispatchReviewer: (issueNumber: number): void => {
        void agentManager.dispatchReviewer({ issueNumber });
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
    dispatchImplementor(command: DispatchImplementorCommand): void {
      handleDispatchImplementor(command.issueNumber, issuePoller, agentManager, logger);
    },
    dispatchReviewer(command: DispatchReviewerCommand): void {
      handleDispatchReviewer(command.issueNumber, issuePoller, agentManager, logger);
    },
    cancelAgent(command: CancelAgentCommand): void {
      agentManager.cancelAgent(command.issueNumber);
    },
    cancelPlanner(_command: CancelPlannerCommand): void {
      agentManager.cancelPlanner();
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
        logger,
      });
      emitter.on(eventHandler);

      // Step 2: Startup recovery
      const recoveryResult = await recovery.performStartupRecovery();

      // Step 3: First IssuePoller cycle
      await issuePoller.poll();

      // Step 4: First SpecPoller cycle
      const specResult = await specPoller.poll();
      dispatch.handleSpecPollerResult(specResult);

      // Step 5: Start recurring poll timers
      pollerTimers.issueTimer = setInterval(() => {
        logger.debug('IssuePoller cycle starting');
        void issuePoller.poll();
      }, resolved.issuePoller.pollInterval * SECONDS_TO_MS);

      pollerTimers.specTimer = setInterval(() => {
        logger.debug('SpecPoller cycle starting');
        void specPoller.poll().then((result) => {
          dispatch.handleSpecPollerResult(result);
        });
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
  logger: Logger;
}

function buildEventHandler(deps: EventHandlerDeps): (event: EngineEvent) => void {
  const { agentManager, recovery, issuePoller, dispatch, logger } = deps;
  return (event: EngineEvent): void => {
    if (event.type === 'issueStatusChanged') {
      dispatch.handleIssueStatusChanged(event);
    }

    if (event.type === 'issueRemoved' && agentManager.isRunning(event.issueNumber)) {
      agentManager.cancelAgent(event.issueNumber);
    }

    if (
      (event.type === 'agentCompleted' || event.type === 'agentFailed') &&
      event.issueNumber !== undefined
    ) {
      const snapshotAdapter = buildSnapshotAdapter(issuePoller);

      recovery
        .performCrashRecovery({
          agentType: event.agentType,
          issueNumber: event.issueNumber,
          snapshot: snapshotAdapter,
        })
        .catch((error) => {
          logger.error('Crash recovery failed', {
            issueNumber: event.issueNumber,
            error: String(error),
          });
        });
    }
  };
}

// ---------------------------------------------------------------------------
// Snapshot adapter
// ---------------------------------------------------------------------------

// The IssuePoller exposes getSnapshot() returning ReadonlyMap, but the Recovery
// module needs IssuePollerSnapshot with get/set. The underlying JS Map supports
// set at runtime -- ReadonlyMap is a TypeScript-only restriction. This adapter
// bridges the two interfaces. The type assertion is necessary because the
// IssuePoller API (out of scope for this task) only exposes ReadonlyMap.
function buildSnapshotAdapter(issuePoller: IssuePoller): IssuePollerSnapshot {
  return {
    get(issueNumber: number): IssueSnapshotEntry | undefined {
      return issuePoller.getSnapshot().get(issueNumber);
    },
    set(issueNumber: number, entry: IssueSnapshotEntry): void {
      const mutableSnapshot = issuePoller.getSnapshot() as Map<number, IssueSnapshot>;
      mutableSnapshot.set(issueNumber, entry);
    },
  };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

const USER_DISPATCH_STATUSES: Set<string> = new Set(['pending', 'unblocked', 'needs-changes']);

function handleDispatchImplementor(
  issueNumber: number,
  issuePoller: IssuePoller,
  agentManager: AgentManager,
  logger: Logger,
): void {
  const issue = issuePoller.getSnapshot().get(issueNumber);

  if (!issue) {
    return;
  }

  const isUserDispatchStatus = USER_DISPATCH_STATUSES.has(issue.statusLabel);
  const isInProgress = issue.statusLabel === 'in-progress';

  if (!(isUserDispatchStatus || isInProgress)) {
    return;
  }

  agentManager.dispatchImplementor({ issueNumber }).catch((error) => {
    logger.error('Failed to dispatch implementor', {
      issueNumber,
      error: String(error),
    });
  });
}

function handleDispatchReviewer(
  issueNumber: number,
  issuePoller: IssuePoller,
  agentManager: AgentManager,
  logger: Logger,
): void {
  const issue = issuePoller.getSnapshot().get(issueNumber);

  if (!issue) {
    return;
  }
  if (issue.statusLabel !== 'review') {
    return;
  }

  agentManager.dispatchReviewer({ issueNumber }).catch((error) => {
    logger.error('Failed to dispatch reviewer', {
      issueNumber,
      error: String(error),
    });
  });
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

  const shutdownTimer = setTimeout(() => {
    clearInterval(checkInterval);
    agentManager.cancelAll();
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
