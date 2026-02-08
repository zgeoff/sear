import { readFileSync } from 'node:fs';
import type { Engine, EngineConfig, EngineEvent } from '../types';
import { buildQueryFactory } from './agent-manager/build-query-factory';
import { createAgentManager } from './agent-manager/create-agent-manager';
import type { AgentManager, QueryFactory } from './agent-manager/types';
import { createCommandDispatcher } from './command-dispatcher/create-command-dispatcher';
import { buildResolvedConfig } from './config/build-resolved-config';
import type { ResolvedEngineConfig } from './config/types';
import type { Logger } from './create-logger';
import { createLogger } from './create-logger';
import { createDispatch } from './dispatch/create-dispatch';
import type { Dispatch } from './dispatch/types';
import { createEventEmitter } from './event-emitter/create-event-emitter';
import { createGitHubClient } from './github-client/create-github-client';
import type { GitHubClient } from './github-client/types';
import { createIssuePoller } from './pollers/create-issue-poller';
import { createSpecPoller } from './pollers/create-spec-poller';
import type { IssuePoller, IssueSnapshot } from './pollers/types';
import { getIssueDetails } from './queries/get-issue-details';
import { getPRForIssue } from './queries/get-pr-for-issue';
import type { QueriesConfig } from './queries/types';
import { createRecovery } from './recovery/create-recovery';
import type { IssuePollerSnapshot, Recovery } from './recovery/types';
import { createWorktreeManager } from './worktree-manager/create-worktree-manager';
import type { WorktreeManager } from './worktree-manager/types';

type EngineDeps = {
  octokit?: GitHubClient;
  queryFactory?: QueryFactory;
  repoRoot?: string;
  worktreeManager?: WorktreeManager;
};

type PollerTimers = {
  issueTimer: ReturnType<typeof setInterval> | null;
  specTimer: ReturnType<typeof setInterval> | null;
};

export function createEngine(config: EngineConfig, deps?: EngineDeps): Engine {
  const resolved = buildResolvedConfig(config);
  const [owner = '', repo = ''] = resolved.repository.split('/');
  const logger = createLogger(resolved);
  const repoRoot = deps?.repoRoot ?? process.cwd();

  const octokit = deps?.octokit ?? buildGitHubClient(resolved);

  const emitter = createEventEmitter();
  const recovery = createRecovery({ octokit, owner, repo, emitter });
  const worktreeManager = deps?.worktreeManager ?? createWorktreeManager({ repoRoot });

  const issuePoller = createIssuePoller({
    octokit,
    owner,
    repo,
    emitter,
    logError: (message, error) => logger.error(message, { error: String(error) }),
  });

  const specPoller = createSpecPoller({
    octokit,
    owner,
    repo,
    specsDir: resolved.specPoller.specsDir,
    defaultBranch: resolved.specPoller.defaultBranch,
    logError: (message, error) => logger.error(message, { error: String(error) }),
  });

  const agentManager = createAgentManager({
    emitter,
    worktreeManager,
    repoRoot,
    agentPlanner: resolved.agents.agentPlanner,
    agentImplementor: resolved.agents.agentImplementor,
    agentReviewer: resolved.agents.agentReviewer,
    maxAgentDuration: resolved.agents.maxAgentDuration,
    queryFactory: deps?.queryFactory ?? buildQueryFactory(),
  });

  const dispatch = createDispatch(
    emitter,
    {
      dispatchPlanner: (specPaths) => agentManager.dispatchPlanner({ specPaths }),
      dispatchReviewer: (issueNumber) => agentManager.dispatchReviewer({ issueNumber }),
      isPlannerRunning: () => agentManager.isPlannerRunning(),
    },
    { repository: resolved.repository },
  );

  const queriesConfig: QueriesConfig = { octokit, owner, repo };

  const pollerTimers: PollerTimers = {
    issueTimer: null,
    specTimer: null,
  };

  const commandDispatcher = createCommandDispatcher({
    dispatchImplementor(command) {
      handleDispatchImplementor(command.issueNumber, issuePoller, agentManager, logger);
    },
    dispatchReviewer(command) {
      handleDispatchReviewer(command.issueNumber, issuePoller, agentManager);
    },
    cancelAgent(command) {
      agentManager.cancelAgent(command.issueNumber);
    },
    cancelPlanner() {
      agentManager.cancelPlanner();
    },
    shutdown() {
      initiateShutdown(resolved, logger, agentManager, pollerTimers);
    },
  });

  return {
    async start() {
      logger.info('Engine starting', {
        repository: resolved.repository,
        logLevel: resolved.logLevel,
        issuePollInterval: resolved.issuePoller.pollInterval,
        specPollInterval: resolved.specPoller.pollInterval,
      });

      // Step 1: Wire event handler before any events are emitted
      const eventHandler = buildEventHandler(agentManager, recovery, issuePoller, dispatch, logger);
      emitter.on(eventHandler);

      // Step 2: Startup recovery
      const recoveryResult = await recovery.performStartupRecovery();

      // Step 3: First IssuePoller cycle
      await issuePoller.poll();

      // Step 4: First SpecPoller cycle
      const specResult = await specPoller.poll();
      dispatch.handleSpecPollerResult(specResult);

      // Step 5: Start recurring poll timers
      pollerTimers.issueTimer = setInterval(async () => {
        logger.debug('IssuePoller cycle starting');
        await issuePoller.poll();
      }, resolved.issuePoller.pollInterval * 1000);

      pollerTimers.specTimer = setInterval(async () => {
        logger.debug('SpecPoller cycle starting');
        const result = await specPoller.poll();
        dispatch.handleSpecPollerResult(result);
      }, resolved.specPoller.pollInterval * 1000);

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

    on(handler) {
      return emitter.on(handler);
    },

    send(command) {
      commandDispatcher.dispatch(command);
    },

    getIssueDetails(issueNumber) {
      return getIssueDetails(queriesConfig, issueNumber);
    },

    getPRForIssue(issueNumber) {
      return getPRForIssue(queriesConfig, issueNumber);
    },

    getAgentStream(issueNumber) {
      return agentManager.getAgentStream(issueNumber);
    },
  };
}

// ---------------------------------------------------------------------------
// Event handler (wires poller events to dispatch, agent cancellation, recovery)
// ---------------------------------------------------------------------------

function buildEventHandler(
  agentManager: AgentManager,
  recovery: Recovery,
  issuePoller: IssuePoller,
  dispatch: Dispatch,
  logger: Logger,
): (event: EngineEvent) => void {
  return (event) => {
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
    get(issueNumber) {
      return issuePoller.getSnapshot().get(issueNumber);
    },
    set(issueNumber, entry) {
      const mutableSnapshot = issuePoller.getSnapshot() as Map<number, IssueSnapshot>;
      mutableSnapshot.set(issueNumber, entry);
    },
  };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

const USER_DISPATCH_STATUSES = new Set(['pending', 'unblocked', 'needs-changes']);

function handleDispatchImplementor(
  issueNumber: number,
  issuePoller: IssuePoller,
  agentManager: AgentManager,
  logger: Logger,
): void {
  const issue = issuePoller.getSnapshot().get(issueNumber);

  if (!issue) return;
  if (!USER_DISPATCH_STATUSES.has(issue.statusLabel)) return;

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
): void {
  const issue = issuePoller.getSnapshot().get(issueNumber);

  if (!issue) return;
  if (issue.statusLabel !== 'review') return;

  agentManager.dispatchReviewer({ issueNumber });
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
  }, config.shutdownTimeout * 1000);

  const checkInterval = setInterval(() => {
    const remaining = agentManager.getRunningSessionIDs().length;
    if (remaining === 0) {
      clearInterval(checkInterval);
      clearTimeout(shutdownTimer);
      logger.info('Shutdown complete', { agentsTerminated: 0 });
    }
  }, 1000);
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
