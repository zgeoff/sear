---
title: Control Plane Engine — Recovery
version: 0.2.0
last_updated: 2026-02-09
status: approved
---

# Control Plane Engine — Recovery

## Overview

The engine performs recovery to ensure no issue is permanently stuck in `status:in-progress` due to agent failure, engine restart, or an agent that completes without updating the status label. Recovery resets stale `status:in-progress` issues to `status:pending` and emits synthetic events so the TUI can update immediately.

## Constraints

- The `in-progress → pending` reset is an administrative override that bypasses the normal transition table defined in `workflow.md`. The only other engine-initiated status change is the `in-progress → review` transition during completion-dispatch (see [control-plane-engine.md: Completion-dispatch](./control-plane-engine.md#completion-dispatch)).
- Recovery events must include `isRecovery: true` on synthetic `issueStatusChanged` events so the TUI can distinguish them from normal poll-detected changes (the failure overlay must survive recovery).

## Specification

### Startup Recovery

On initialization, after planner cache load and before pollers start:

1. Query all open issues with `task:implement` label via `GitHubClient`.
2. For each issue with `status:in-progress`, check if an agent session is tracked for it.
3. Since no agents are tracked at startup, all `status:in-progress` issues are stale.
4. Reset each to `status:pending` via `GitHubClient`. If the label reset fails for an issue (API error), log the error and skip that issue — continue with remaining issues. The skipped issue remains `status:in-progress` and will be detected as stale on the first IssuePoller cycle.
5. Emit `recoveryPerformed` for each.
6. Emit a synthetic `issueStatusChanged` for each (oldStatus: `in-progress`, newStatus: `pending`, `isRecovery: true`), populated from the GitHub API response (title, priority label, creation date) — the IssuePoller snapshot is not yet available at startup. Synthetic events pass through the dispatch logic like any other `issueStatusChanged` — so recovered issues with `newStatus: 'pending'` will emit `dispatchReady`. This ensures the TUI store populates recovered issues immediately and surfaces them as ready for dispatch.
7. The Engine Core seeds the IssuePoller snapshot with each recovered issue via `updateEntry()` (status: `pending`) to prevent duplicate `issueStatusChanged` events on the first poll cycle.

### Crash Recovery

The Engine Core invokes crash recovery after an Implementor or Reviewer agent session completes (success or failure). Planner sessions skip crash recovery entirely (no associated issue). The Agent Manager reports completion to the Engine Core; the Engine Core calls Recovery. This avoids a circular dependency between the Agent Manager and Recovery modules. The Engine Core emits `agentFailed` (or `agentCompleted`) before calling crash recovery, ensuring `lastFailure` is recorded in the TUI store before the recovery's synthetic `issueStatusChanged` arrives.

1. Check if the issue still has `status:in-progress`.
2. If yes, reset to `status:pending` via `GitHubClient`. If the reset fails (API error), log the error and return `false` — the issue remains `status:in-progress` and will be retried on the next agent completion or detected on the next IssuePoller cycle.
3. Emit `recoveryPerformed`.
4. Emit a synthetic `issueStatusChanged` (oldStatus: `in-progress`, newStatus: `pending`, `isRecovery: true`) so the TUI store updates immediately rather than waiting for the next poll cycle. Populate all standard fields (title, priority label, creation date) from the IssuePoller snapshot (available during normal operation — avoids an extra API call). Synthetic events pass through the dispatch logic, so this will also emit `dispatchReady`. The `isRecovery` flag tells the TUI store to update the status label without clearing `lastFailure` (the failure overlay must survive recovery). Update the IssuePoller snapshot to match.

This ensures no issue is permanently stuck in `status:in-progress` due to agent failure or an agent that succeeds without updating the label.

### Reviewer Failure

Crash recovery only applies to `status:in-progress`. When a Reviewer fails, the issue remains `status:review` (Reviewers do not change the status to `in-progress`). No recovery is performed — the issue stays in `status:review` with no running agent. The TUI surfaces the failure via `lastFailure` (see `control-plane-tui-failure-overlay.md`), and the user can retry via the `dispatchReviewer` command. The IssuePoller will not re-trigger auto-dispatch because the status hasn't changed since the last poll.

### Module Location

The Recovery logic lives in `engine/recovery/`. The module contains:

- `types.ts` — `RecoveryConfig`, `RecoveredIssue`, `Recovery` interface type.
- `create-recovery.ts` — Factory function implementing `performStartupRecovery()` and `performCrashRecovery()`.

The Engine Core imports and invokes recovery functions — the Agent Manager does not call recovery directly.

### Type Definitions

```ts
type RecoveryConfig = {
  gitHubClient: GitHubClient;
  owner: string;
  repo: string;
};

// One entry per issue recovered during startup recovery. The Engine Core
// uses these to emit recoveryPerformed and synthetic issueStatusChanged events.
// RecoveredIssue carries the same issue metadata as IssueSnapshotEntry (see pollers spec).
// The Engine Core maps issueNumber → number and sets statusLabel: 'pending' when
// seeding the IssuePoller snapshot.
type RecoveredIssue = {
  issueNumber: number;
  title: string;
  priorityLabel: string;
  createdAt: string; // ISO 8601
};

type Recovery = {
  // Queries GitHub for all in-progress task:implement issues and resets each to pending.
  // Returns the list of recovered issues so the Engine Core can emit events
  // and populate the IssuePoller snapshot with recovered issue data.
  performStartupRecovery(): Promise<RecoveredIssue[]>;
  // Checks if the given issue is still status:in-progress (via GitHubClient)
  // and resets it to status:pending if so. Returns boolean (not RecoveredIssue)
  // because the Engine Core retrieves issue metadata from the IssuePoller
  // snapshot when true. When true, the Engine Core emits events and updates
  // the IssuePoller snapshot.
  performCrashRecovery(issueNumber: number): Promise<boolean>;
};

// createRecovery(config: RecoveryConfig): Recovery
```

Event emission (`recoveryPerformed`, synthetic `issueStatusChanged`) and IssuePoller snapshot updates are the Engine Core's responsibility after calling these methods. Recovery handles the GitHub API interaction (status checking and label resets).

## Acceptance Criteria

- [ ] Given the engine starts and an issue has `status:in-progress`, when no agent is tracked for it, then the issue is reset to `status:pending`.
- [ ] Given an agent session completes and the issue is still `status:in-progress`, when the completion is detected, then the issue is reset to `status:pending` and `recoveryPerformed` is emitted.
- [ ] Given recovery resets an issue to `status:pending`, when the recovery completes, then both `recoveryPerformed` and a synthetic `issueStatusChanged` (with `isRecovery: true`) are emitted so the TUI updates immediately.
- [ ] Given a Reviewer fails, when the failure is detected, then no recovery is performed and the issue remains `status:review`.
- [ ] Given crash recovery resets an issue to `status:pending`, when the IssuePoller snapshot is updated to match, then the next IssuePoller cycle does not emit a duplicate `issueStatusChanged` for that issue.
- [ ] Given startup recovery resets an issue to `status:pending`, then a `dispatchReady` event is emitted for that issue (via the synthetic `issueStatusChanged` passing through dispatch logic).
- [ ] Given an Implementor fails and crash recovery runs, when events are emitted, then `agentFailed` is emitted before `recoveryPerformed` and the synthetic `issueStatusChanged`.

## Dependencies

- `control-plane-engine.md` — Parent engine spec (GitHubClient, event types, IssuePoller snapshot)
- `control-plane-engine-pollers.md` — IssuePoller snapshot (recovery modifies the snapshot to prevent duplicate events)
- `control-plane-engine-agent-manager.md` — Agent Manager (reports agent completion to Engine Core, which invokes recovery)
- `workflow.md` — Status transition table (recovery bypasses normal transitions)

## References

- [control-plane-engine.md: Dispatch Logic](./control-plane-engine.md#dispatch-logic) — Synthetic events pass through dispatch logic
- [control-plane-engine-agent-manager.md: Agent Lifecycle](./control-plane-engine-agent-manager.md#agent-lifecycle) — Crash recovery triggered after agent completion
- `control-plane-tui-failure-overlay.md` — Failure overlay behavior (consumes `isRecovery` flag to preserve overlay during recovery)
