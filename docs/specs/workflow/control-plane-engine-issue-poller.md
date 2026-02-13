---
title: Control Plane Engine — Issue Poller
version: 0.4.0
last_updated: 2026-02-13
status: approved
---

# Control Plane Engine — Issue Poller

## Overview

The IssuePoller monitors GitHub Issues for status label changes. It is a pure sensor — it detects
state changes and reports them via callbacks. It does not make dispatch decisions.

## Constraints

- Must not make dispatch decisions or emit notifications. The IssuePoller reports state changes; the
  Engine Core decides what to do about them.
- Only tracks `task:implement` issues — `task:refinement` issues are outside the control plane's
  scope (they do not have status transitions that drive agent dispatch).
- IssuePoller errors are non-fatal — the engine continues operating.

## Specification

### Poll Cycle

The IssuePoller runs on its own interval.

**Poll cycle steps:**

1. Query open issues with the `task:implement` label via `GitHubClient`.
2. For each issue, compare the current `status:*` label against the snapshot.
3. For each change, emit `issueStatusChanged` with the issue number, old status, and new status.
4. Update the snapshot.

**Snapshot state:**

| Field          | Description                      |
| -------------- | -------------------------------- |
| Issue number   | GitHub Issue number              |
| Title          | Issue title                      |
| Status label   | Current `status:*` label value   |
| Priority label | Current `priority:*` label value |
| Creation date  | ISO 8601 timestamp               |

**Change detection:** Only `status:*` label changes trigger `issueStatusChanged` events. Title,
priority, and creation date are included in the event payload for convenience (the IssuePoller
already has this data from the API response) but changes to these fields alone do not trigger
events. The snapshot tracks them so they can be included in future events.

**Closed issue detection:** On each poll cycle, the IssuePoller compares the set of issue numbers in
the API response against the snapshot. Issues present in the snapshot but absent from the response
have been closed or had their `task:implement` label removed. For each removed issue, the
IssuePoller removes it from the snapshot and reports the removal to the Engine Core. The Engine Core
handles the orchestration response — see
[control-plane-engine.md: Dispatch Logic](./control-plane-engine.md#dispatch-logic) for the agent
cancellation and `issueStatusChanged(newStatus: null)` emission sequence.

**Initial poll cycle:** On the first cycle, the snapshot is empty. All detected issues are treated
as new — each emits an `issueStatusChanged` event with `oldStatus: null`. This is how the engine
populates the initial issue set. The dispatch logic treats `oldStatus: null` the same as any other
status change for tier classification.

**Startup burst:** This means the first poll cycle may trigger dispatch actions for all existing
issues simultaneously: `issueStatusChanged` events for all issues, surfacing `status:pending` issues
to the TUI for user-dispatch and notifying the TUI of all other statuses. This is intentional — if
the control plane starts (or restarts), it should bring the system to the correct state. Startup
recovery completes before the first poll cycle, so `status:in-progress` issues will already be reset
to `status:pending`. Note: `status:review` issues do not trigger Reviewer dispatch on startup —
Reviewer dispatch is completion-driven, not label-driven (see
[control-plane-engine.md: Completion-dispatch](./control-plane-engine.md#completion-dispatch)).

**First-cycle execution:** `Engine.start()` runs the first poll cycle of each poller as a direct
invocation, not via the interval timer. It awaits all first cycles before resolving. Interval-based
polling begins after the first cycles complete.

> **Rationale:** This ensures the TUI receives the initial issue set and any startup-triggered
> dispatch events before `start()` resolves.

### Type Definitions

```ts
type IssueSnapshotEntry = {
  number: number;
  title: string;
  statusLabel: string;
  priorityLabel: string;
  createdAt: string; // ISO 8601
};

type IssuePollerSnapshot = Map<number, IssueSnapshotEntry>;

type IssuePoller = {
  poll(): Promise<void>; // runs one poll cycle, emitting events for detected changes
  getSnapshot(): IssuePollerSnapshot;
  updateEntry(issueNumber: number, entry: IssueSnapshotEntry): void; // updates a single snapshot entry (used by Engine Core during crash recovery and completion-dispatch to prevent duplicate events on next poll)
  stop(): void; // stops the interval timer
};

type IssuePollerConfig = {
  gitHubClient: GitHubClient;
  owner: string;
  repo: string;
  pollInterval: number; // seconds
  onIssueStatusChanged: (event: IssueStatusChangedEvent) => void;
  onIssueRemoved: (issueNumber: number) => void; // passes only issueNumber — the Engine Core looks up agent state and constructs events from its own tracking data
};

// createIssuePoller(config: IssuePollerConfig): IssuePoller
```

## Acceptance Criteria

- [ ] Given the IssuePoller is running, when its poll interval elapses, then it queries GitHub
      Issues independently of other pollers.
- [ ] Given the IssuePoller runs its first cycle with an empty snapshot, when issues are detected,
      then each emits `issueStatusChanged` with `oldStatus: null`.
- [ ] Given the IssuePoller encounters a GitHub API error, when the error occurs, then other pollers
      continue operating on their own intervals.
- [ ] Given the IssuePoller detects issues in the API response, when processing the results, then
      only issues with the `task:implement` label are tracked — `task:refinement` issues are
      ignored.
- [ ] Given an issue was present in the previous poll but is absent from the current poll results,
      when the IssuePoller processes the cycle, then the issue is removed from the snapshot and the
      removal is reported to the Engine Core.
- [ ] Given `Engine.start()` is called, when the first IssuePoller cycle runs, then it is executed
      as a direct invocation (not via the interval timer) and `start()` awaits its completion before
      resolving.
- [ ] Given `getSnapshot()` is called on the IssuePoller, when the snapshot is returned, then it
      contains the current status, title, priority, and creation date for each tracked issue.

## Dependencies

- [control-plane-engine.md](./control-plane-engine.md) — Parent engine spec (architecture,
  GitHubClient, event types, dispatch logic, configuration)

## References

- [control-plane-engine.md: Architecture](./control-plane-engine.md#architecture) — Engine layering
  diagram
- [control-plane-engine.md: Dispatch Logic](./control-plane-engine.md#dispatch-logic) — How poller
  results drive dispatch decisions
- [control-plane-engine.md: Configuration](./control-plane-engine.md#configuration) — IssuePoller
  configuration settings
- [control-plane-engine-recovery.md](./control-plane-engine-recovery.md) — Startup recovery
  completes before first poll cycle
