import type { IssueStatusChangedEvent, SpecPollerBatchResult } from '../../types.ts';
import type { EventEmitter } from '../event-emitter/types.ts';
import type { AgentManagerDelegate, Dispatch, DispatchConfig } from './types.ts';

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

export function createDispatch(
  emitter: EventEmitter,
  agentManager: AgentManagerDelegate,
  _config: DispatchConfig,
): Dispatch {
  const deferredPaths = new Set<string>();
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

    async handleIssueStatusChanged(_event: IssueStatusChangedEvent): Promise<void> {
      // Granular dispatch events (dispatchReady, issueBlocked, etc.) have been removed.
      // The issueStatusChanged event was already emitted by the IssuePoller; the TUI
      // derives all display state from the core events.
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
    emitter.emit({
      type: 'specChanged',
      filePath: change.filePath,
      frontmatterStatus: change.frontmatterStatus,
      changeType: change.changeType,
      commitSHA: result.commitSHA,
    });
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

  // Check Planner concurrency guard — skip silently if already running
  if (agentManager.isPlannerRunning()) {
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
