import { match, P } from 'ts-pattern';
import type {
  EngineEvent,
  IssueBlockedEvent,
  IssueNeedsRefinementEvent,
  IssueStatusChangedEvent,
  PRApprovedEvent,
  SpecPollerBatchResult,
} from '../../types.ts';
import type { EventEmitter } from '../event-emitter/types.ts';
import type { AgentManagerDelegate, Dispatch, DispatchConfig } from './types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_DISPATCH_STATUSES: string[] = ['pending', 'unblocked', 'needs-changes'];

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

export function createDispatch(
  emitter: EventEmitter,
  agentManager: AgentManagerDelegate,
  config: DispatchConfig,
): Dispatch {
  const deferredPaths = new Set<string>();
  const activeNotifications = new Map<number, string>(); // issueNumber -> statusLabel
  // Tracks the latest frontmatter status for each spec path from the most recent SpecPoller result.
  // Used to filter deferred paths at dispatch time -- paths whose status changed to non-approved
  // since deferral are dropped.
  const latestSpecStatuses = new Map<string, string>();

  return {
    async handleSpecPollerResult(result: SpecPollerBatchResult): Promise<void> {
      await handleSpecPollerResult(result, {
        emitter,
        agentManager,
        deferredPaths,
        latestSpecStatuses,
      });
    },

    async handleIssueStatusChanged(event: IssueStatusChangedEvent): Promise<void> {
      await handleIssueStatusChanged(event, {
        emitter,
        config,
        activeNotifications,
      });
    },

    handlePlannerFailed(specPaths: string[]): void {
      for (const path of specPaths) {
        deferredPaths.add(path);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SpecPoller result handling
// ---------------------------------------------------------------------------

interface HandleSpecPollerResultDeps {
  emitter: EventEmitter;
  agentManager: AgentManagerDelegate;
  deferredPaths: Set<string>;
  latestSpecStatuses: Map<string, string>;
}

async function handleSpecPollerResult(
  result: SpecPollerBatchResult,
  deps: HandleSpecPollerResultDeps,
): Promise<void> {
  const { emitter, agentManager, deferredPaths, latestSpecStatuses } = deps;
  // Update the latest known statuses from this cycle's results
  for (const change of result.changes) {
    latestSpecStatuses.set(change.filePath, change.frontmatterStatus);
  }

  // Emit specChanged events for each change (for TUI notification history)
  for (const change of result.changes) {
    const event: EngineEvent = {
      type: 'specChanged',
      filePath: change.filePath,
      frontmatterStatus: change.frontmatterStatus,
      changeType: change.changeType,
      commitSHA: result.commitSHA,
    };
    emitter.emit(event);
  }

  // Collect approved paths from this cycle
  const approvedFromCycle = result.changes
    .filter((c) => c.frontmatterStatus === 'approved')
    .map((c) => c.filePath);

  // Merge with deferred paths (union, deduplicated)
  for (const path of approvedFromCycle) {
    deferredPaths.add(path);
  }

  if (deferredPaths.size === 0) {
    return;
  }

  // Apply approval filter at dispatch time -- drop paths whose status is no longer approved
  const pathsToDispatch = filterApprovedPaths(deferredPaths, latestSpecStatuses);

  if (pathsToDispatch.length === 0) {
    deferredPaths.clear();
    return;
  }

  // Check Planner concurrency guard
  if (agentManager.isPlannerRunning()) {
    emitter.emit({
      type: 'agentSkipped',
      agentType: 'planner',
      specPaths: [...deferredPaths],
    });
    return;
  }

  // Dispatch Planner with all approved paths
  await agentManager.dispatchPlanner(pathsToDispatch);
  deferredPaths.clear();
}

function filterApprovedPaths(paths: Set<string>, latestStatuses: Map<string, string>): string[] {
  const approved: string[] = [];
  for (const path of paths) {
    const status = latestStatuses.get(path);
    if (status === 'approved') {
      approved.push(path);
    }
  }
  return approved;
}

// ---------------------------------------------------------------------------
// Issue status change handling
// ---------------------------------------------------------------------------

interface HandleIssueStatusChangedDeps {
  emitter: EventEmitter;
  config: DispatchConfig;
  activeNotifications: Map<number, string>;
}

async function handleIssueStatusChanged(
  event: IssueStatusChangedEvent,
  deps: HandleIssueStatusChangedDeps,
): Promise<void> {
  const { emitter, config, activeNotifications } = deps;
  // Dismiss any active notification for this issue if the status changed
  const activeStatus = activeNotifications.get(event.issueNumber);
  if (activeStatus !== undefined) {
    activeNotifications.delete(event.issueNumber);
    emitter.emit(buildDismissalEvent(event.issueNumber, activeStatus));
  }

  await match(event.newStatus)
    .with(
      P.when((s) => USER_DISPATCH_STATUSES.includes(s)),
      () => {
        emitter.emit({
          type: 'dispatchReady',
          issueNumber: event.issueNumber,
          statusLabel: `status:${event.newStatus}`,
        });
      },
    )
    .with('needs-refinement', () => {
      activeNotifications.set(event.issueNumber, event.newStatus);
      emitter.emit(buildIssueNeedsRefinementEvent(event, config));
    })
    .with('blocked', () => {
      activeNotifications.set(event.issueNumber, event.newStatus);
      emitter.emit(buildIssueBlockedEvent(event, config));
    })
    .with('approved', () => {
      activeNotifications.set(event.issueNumber, event.newStatus);
      emitter.emit(buildPRApprovedEvent(event, config));
    })
    .otherwise(() => {
      // Fallthrough -- status changes like 'in-progress', 'review' trigger no dispatch action.
      // The issueStatusChanged event was already emitted by the IssuePoller.
    });
}

// ---------------------------------------------------------------------------
// Granular event builders
// ---------------------------------------------------------------------------

function buildDismissalEvent(issueNumber: number, activeStatus: string): EngineEvent {
  return match(activeStatus)
    .with('needs-refinement', () => ({
      type: 'issueRefined' as const,
      issueNumber,
    }))
    .with('blocked', () => ({
      type: 'issueUnblocked' as const,
      issueNumber,
    }))
    .with('approved', () => ({
      type: 'prUnapproved' as const,
      issueNumber,
    }))
    .otherwise(() => ({
      type: 'issueUnblocked' as const,
      issueNumber,
    }));
}

function buildIssueNeedsRefinementEvent(
  event: IssueStatusChangedEvent,
  config: DispatchConfig,
): IssueNeedsRefinementEvent {
  const [owner, repo] = config.repository.split('/');
  return {
    type: 'issueNeedsRefinement',
    issueNumber: event.issueNumber,
    clipboardCommand: `claude -p "Use /spec-writing to address the spec refinement needed for issue #${event.issueNumber}. See blocker comment: https://github.com/${owner}/${repo}/issues/${event.issueNumber}"`,
    contextURL: `https://github.com/${owner}/${repo}/issues/${event.issueNumber}`,
    resolutionGuidance: 'After amending the spec, change the label to status:unblocked.',
  };
}

function buildIssueBlockedEvent(
  event: IssueStatusChangedEvent,
  config: DispatchConfig,
): IssueBlockedEvent {
  const [owner, repo] = config.repository.split('/');
  return {
    type: 'issueBlocked',
    issueNumber: event.issueNumber,
    contextURL: `https://github.com/${owner}/${repo}/issues/${event.issueNumber}`,
    resolutionGuidance: 'After resolving the blocker, change the label to status:unblocked.',
  };
}

function buildPRApprovedEvent(
  event: IssueStatusChangedEvent,
  config: DispatchConfig,
): PRApprovedEvent {
  const [owner, repo] = config.repository.split('/');
  return {
    type: 'prApproved',
    issueNumber: event.issueNumber,
    contextURL: `https://github.com/${owner}/${repo}/issues/${event.issueNumber}`,
  };
}
