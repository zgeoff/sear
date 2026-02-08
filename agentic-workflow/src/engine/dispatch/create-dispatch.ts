import { match, P } from 'ts-pattern';
import type {
  EngineEvent,
  IssueStatusChangedEvent,
  NotificationEvent,
  SpecPollerBatchResult,
} from '../../types.js';
import type { EventEmitter } from '../event-emitter/create-event-emitter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentManagerDelegate = {
  dispatchPlanner(specPaths: string[]): void;
  dispatchReviewer(issueNumber: number): void;
  isPlannerRunning(): boolean;
};

export type DispatchConfig = {
  repository: string; // owner/repo format
};

export type Dispatch = {
  handleSpecPollerResult(result: SpecPollerBatchResult): void;
  handleIssueStatusChanged(event: IssueStatusChangedEvent): void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_DISPATCH_STATUSES = ['pending', 'unblocked', 'needs-changes'];

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
    handleSpecPollerResult(result) {
      handleSpecPollerResult(result, emitter, agentManager, deferredPaths, latestSpecStatuses);
    },

    handleIssueStatusChanged(event) {
      handleIssueStatusChanged(event, emitter, agentManager, config, activeNotifications);
    },
  };
}

// ---------------------------------------------------------------------------
// SpecPoller result handling
// ---------------------------------------------------------------------------

function handleSpecPollerResult(
  result: SpecPollerBatchResult,
  emitter: EventEmitter,
  agentManager: AgentManagerDelegate,
  deferredPaths: Set<string>,
  latestSpecStatuses: Map<string, string>,
): void {
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

  if (deferredPaths.size === 0) return;

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
  agentManager.dispatchPlanner(pathsToDispatch);
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

function handleIssueStatusChanged(
  event: IssueStatusChangedEvent,
  emitter: EventEmitter,
  agentManager: AgentManagerDelegate,
  config: DispatchConfig,
  activeNotifications: Map<number, string>,
): void {
  // Dismiss any active notification for this issue if the status changed
  if (activeNotifications.has(event.issueNumber)) {
    activeNotifications.delete(event.issueNumber);
    emitter.emit({
      type: 'notificationDismissed',
      issueNumber: event.issueNumber,
    });
  }

  match(event.newStatus)
    .with('review', () => {
      agentManager.dispatchReviewer(event.issueNumber);
    })
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
      const notification = buildNeedsRefinementNotification(event, config);
      activeNotifications.set(event.issueNumber, event.newStatus);
      emitter.emit(notification);
    })
    .with('blocked', () => {
      const notification = buildBlockedNotification(event, config);
      activeNotifications.set(event.issueNumber, event.newStatus);
      emitter.emit(notification);
    })
    .with('approved', () => {
      const notification = buildApprovedNotification(event, config);
      activeNotifications.set(event.issueNumber, event.newStatus);
      emitter.emit(notification);
    })
    .otherwise(() => {
      // Fallthrough -- status changes like 'in-progress' trigger no dispatch action.
      // The issueStatusChanged event was already emitted by the IssuePoller.
    });
}

// ---------------------------------------------------------------------------
// Notification builders
// ---------------------------------------------------------------------------

function buildNeedsRefinementNotification(
  event: IssueStatusChangedEvent,
  config: DispatchConfig,
): NotificationEvent {
  const [owner, repo] = config.repository.split('/');
  return {
    type: 'notification',
    issueNumber: event.issueNumber,
    statusLabel: `status:${event.newStatus}`,
    clipboardCommand: `claude -p "Use /spec-writing to address the spec refinement needed for issue #${event.issueNumber}. See blocker comment: https://github.com/${owner}/${repo}/issues/${event.issueNumber}"`,
    contextURL: `https://github.com/${owner}/${repo}/issues/${event.issueNumber}`,
    resolutionGuidance: 'After amending the spec, change the label to status:unblocked.',
  };
}

function buildBlockedNotification(
  event: IssueStatusChangedEvent,
  config: DispatchConfig,
): NotificationEvent {
  const [owner, repo] = config.repository.split('/');
  return {
    type: 'notification',
    issueNumber: event.issueNumber,
    statusLabel: `status:${event.newStatus}`,
    contextURL: `https://github.com/${owner}/${repo}/issues/${event.issueNumber}`,
    resolutionGuidance: 'After resolving the blocker, change the label to status:unblocked.',
  };
}

function buildApprovedNotification(
  event: IssueStatusChangedEvent,
  config: DispatchConfig,
): NotificationEvent {
  const [owner, repo] = config.repository.split('/');
  return {
    type: 'notification',
    issueNumber: event.issueNumber,
    statusLabel: `status:${event.newStatus}`,
    contextURL: `https://github.com/${owner}/${repo}/issues/${event.issueNumber}`,
  };
}
