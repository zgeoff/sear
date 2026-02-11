---
title: Control Plane Engine — Pollers
version: 0.2.0
last_updated: 2026-02-09
status: approved
---

# Control Plane Engine — Pollers

## Overview

The engine uses two independent pollers to monitor GitHub for state changes. Each poller runs on its own interval, maintains its own snapshot, and reports results to the Engine Core. Pollers are pure sensors — they detect state changes and report them. They do not make dispatch decisions.

## Constraints

- Each poller operates independently. A failure in one poller does not affect others.
- Pollers do not dispatch agents. Dispatch decisions are made by the Engine Core.
- The IssuePoller only tracks `task:implement` issues — `task:refinement` issues are outside the control plane's scope.
- The SpecPoller detects changes remotely via the GitHub API, not from the local filesystem.

## Specification

### IssuePoller

Monitors GitHub Issues for status label changes.

**Poll cycle:**

1. Query open issues with the `task:implement` label via `GitHubClient`. Only `task:implement` issues are tracked — `task:refinement` issues are outside the control plane's scope (they do not have status transitions that drive agent dispatch).
2. For each issue, compare the current `status:*` label against the snapshot.
3. For each change, emit `issueStatusChanged` with the issue number, old status, and new status.
4. Update the snapshot.

**Snapshot state:**

| Field | Description |
|-------|-------------|
| Issue number | GitHub Issue number |
| Title | Issue title |
| Status label | Current `status:*` label value |
| Priority label | Current `priority:*` label value |
| Creation date | ISO 8601 timestamp |

**Change detection:** Only `status:*` label changes trigger `issueStatusChanged` events. Title, priority, and creation date are included in the event payload for convenience (the IssuePoller already has this data from the API response) but changes to these fields alone do not trigger events. The snapshot tracks them so they can be included in future events.

**Closed issue detection:** On each poll cycle, the IssuePoller compares the set of issue numbers in the API response against the snapshot. Issues present in the snapshot but absent from the response have been closed or had their `task:implement` label removed. For each removed issue, the IssuePoller removes it from the snapshot and reports the removal to the Engine Core. The Engine Core handles the orchestration response — see [control-plane-engine.md: Dispatch Logic](./control-plane-engine.md#dispatch-logic) for the agent cancellation and `issueRemoved` emission sequence.

**Initial poll cycle:** On the first cycle, the snapshot is empty. All detected issues are treated as new — each emits an `issueStatusChanged` event with `oldStatus: null`. This is how the engine populates the initial issue set. The dispatch logic treats `oldStatus: null` the same as any other status change for tier classification.

**Startup burst:** This means the first poll cycle may trigger dispatch actions for all existing issues simultaneously: emitting `dispatchReady` for all `status:pending` issues, and emitting notifications for all `status:needs-refinement`/`status:blocked` issues. This is intentional — if the control plane starts (or restarts), it should bring the system to the correct state. Startup recovery completes before the first poll cycle, so `status:in-progress` issues will already be reset to `status:pending`. Note: `status:review` issues do not trigger Reviewer dispatch on startup — Reviewer dispatch is completion-driven, not label-driven (see [control-plane-engine.md: Completion-dispatch](./control-plane-engine.md#completion-dispatch)).

**First-cycle execution:** `Engine.start()` runs the first poll cycle of each poller as a direct invocation, not via the interval timer. It awaits both first cycles before resolving. Interval-based polling begins after the first cycles complete. This ensures the TUI receives the initial issue set and any startup-triggered dispatch events before `start()` resolves.

### SpecPoller

Monitors the specs directory on the default branch for changes, using the GitHub Trees API.

**Poll cycle:**

1. Fetch the tree SHA of the specs directory on the default branch via `GitHubClient`.
2. Compare the tree SHA against the snapshot.
3. If unchanged — notify the Engine Core with an empty batch (`changes: []`). No further API calls are made for this cycle.
4. If changed — fetch the full tree. Compare each entry's blob SHA against the snapshot's per-file entries to classify changes: entries absent from the snapshot are additions, entries with a different blob SHA are modifications, entries present in the snapshot but absent from the tree are removals.
5. For each added or modified file, fetch its content via `repos.getContent` (returns base64-encoded content), decode it, and parse the frontmatter `status` value.
6. Fetch the HEAD commit SHA of the default branch via `git.getRef` (for spec diff URLs in the TUI). Note: this is the current HEAD commit, not necessarily the specific commit that modified each spec file. If multiple commits were pushed between poll cycles, the diff URL shows the HEAD commit's full diff, not a per-file change view. This is a known limitation — acceptable because the notification identifies the changed file path, giving the user enough context to find the relevant changes.
7. Return the complete batch of changes to the Engine Core.
8. Update the snapshot.

The SpecPoller returns results synchronously to the Engine Core on every cycle, even when no changes are detected (empty `changes` array). This ensures the Engine Core can dispatch deferred Planner paths on any cycle (see Planner concurrency guard in [control-plane-engine.md: Dispatch Logic](./control-plane-engine.md#dispatch-logic)), not only when the SpecPoller detects changes. When `changes` is non-empty, the Engine Core emits individual `specChanged` events per file (for the TUI's notification history) and separately passes the full batch of approved spec paths to the dispatch logic for a single Planner invocation. The per-file events are not the input to Planner dispatch — the Engine Core passes the batch directly. This ensures reliable batching.

**Snapshot state:**

| Field | Description |
|-------|-------------|
| Tree SHA | SHA of the specs directory tree on the default branch |
| Per-file entries | Map of file path → blob SHA and frontmatter `status` value |

The tree SHA comparison makes the common case (nothing changed) a single API call. Detailed file inspection only happens when the tree SHA differs.

**Snapshot seeding:** The SpecPoller accepts an optional initial snapshot (tree SHA and per-file entries) via its constructor. When provided, the snapshot starts with the seeded state instead of empty. This enables the Planner Cache (see `control-plane-engine-planner-cache.md`) to prevent redundant Planner runs on engine restart — the SpecPoller compares blob SHAs against the seeded state and only reports files that actually changed. If no seed is provided, the snapshot starts empty (existing behavior).

**Snapshot access:** The SpecPoller exposes a `getSnapshot()` method that returns the current snapshot state (tree SHA and per-file entries) as a `SpecPollerSnapshot`. The Engine Core uses this at Planner dispatch time to capture the state for the Planner Cache.

**Write precondition:** The `specsDirTreeSHA` in the SpecPoller snapshot is non-null after any successful tree fetch. The Planner Cache is only written when a Planner is successfully dispatched, which requires at least one successful SpecPoller cycle — so `specsDirTreeSHA` is guaranteed non-null at cache write time. See `control-plane-engine-planner-cache.md` for the write precondition.

**Removed specs:** If a spec file is deleted, the SpecPoller removes it from its per-file snapshot. No `specChanged` event is emitted for removals — existing task issues for the removed spec are unaffected. The Planner is not notified of removals.

**Reporting asymmetry:** The IssuePoller reports changes via callbacks (push: `onIssueStatusChanged`, `onIssueRemoved`) for real-time event delivery to the Engine Core. The SpecPoller returns batch results synchronously from `poll()` (pull) to enable reliable Planner batching — the Engine Core needs the complete batch before making dispatch decisions.

### Type Definitions

```ts
// --- IssuePoller ---

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

// --- SpecPoller ---

type SpecPollerFileEntry = {
  blobSHA: string;
  frontmatterStatus: string;
};

type SpecPollerSnapshot = {
  specsDirTreeSHA: string | null; // null when snapshot is empty (initial state, no seed)
  files: Record<string, SpecPollerFileEntry>;
};

type SpecChange = {
  filePath: string;
  frontmatterStatus: string;
  changeType: 'added' | 'modified';
};

type SpecPollerBatchResult = {
  changes: SpecChange[];
  commitSHA: string; // HEAD commit SHA on default branch (for diff URLs); empty string when changes is empty (no git.getRef call made). Consumers never encounter the empty string — the Engine Core only emits specChanged events for non-empty batches.
};

type SpecPoller = {
  poll(): Promise<SpecPollerBatchResult>; // runs one poll cycle, returns batch results synchronously
  getSnapshot(): SpecPollerSnapshot;
  stop(): void; // stops the interval timer
};

type SpecPollerConfig = {
  gitHubClient: GitHubClient;
  owner: string;
  repo: string;
  pollInterval: number; // seconds
  specsDir: string; // path relative to repo root
  defaultBranch: string;
  initialSnapshot?: SpecPollerSnapshot; // optional seed from Planner Cache
};

// createSpecPoller(config: SpecPollerConfig): SpecPoller
```

## Acceptance Criteria

### IssuePoller

- [ ] Given the IssuePoller is running, when its poll interval elapses, then it queries GitHub Issues independently of the SpecPoller.
- [ ] Given the IssuePoller runs its first cycle with an empty snapshot, when issues are detected, then each emits `issueStatusChanged` with `oldStatus: null`.
- [ ] Given the IssuePoller encounters a GitHub API error, when the error occurs, then the SpecPoller continues operating on its own interval.
- [ ] Given the IssuePoller detects issues in the API response, when processing the results, then only issues with the `task:implement` label are tracked — `task:refinement` issues are ignored.
- [ ] Given an issue was present in the previous poll but is absent from the current poll results, when the IssuePoller processes the cycle, then the issue is removed from the snapshot and the removal is reported to the Engine Core.
- [ ] Given `Engine.start()` is called, when the first IssuePoller cycle runs, then it is executed as a direct invocation (not via the interval timer) and `start()` awaits its completion before resolving.
- [ ] Given the first IssuePoller cycle completes for a repository with `status:review` issues, when the startup burst fires, then no Reviewers are auto-dispatched — `status:review` is not a dispatch trigger (Reviewer dispatch is completion-driven).
- [ ] Given `getSnapshot()` is called on the IssuePoller, when the snapshot is returned, then it contains the current status, title, priority, and creation date for each tracked issue.

### SpecPoller

- [ ] Given the SpecPoller is running, when its poll interval elapses, then it fetches the tree SHA of the specs directory on the default branch via the GitHub API.
- [ ] Given the SpecPoller detects the tree SHA is unchanged, when the poll cycle completes, then no further API calls are made and the Engine Core receives an empty batch.
- [ ] Given the SpecPoller detects the tree SHA changed, when it inspects the tree, then it compares blob SHAs against its snapshot to identify additions, modifications, and removals, and reads frontmatter status for added and modified files only.
- [ ] Given the SpecPoller detects an added or modified spec file, when it fetches the file content, then it parses the YAML frontmatter to extract the `status` value.
- [ ] Given the SpecPoller detects a removed spec file, when the cycle completes, then the file is removed from the per-file snapshot and no `specChanged` event is emitted for the removal.
- [ ] Given `Engine.start()` is called, when the first SpecPoller cycle runs, then it is executed as a direct invocation (not via the interval timer) and `start()` awaits its completion before resolving.
- [ ] Given the SpecPoller is constructed with an initial snapshot seed, when the first poll cycle runs, then only files with changed blob SHAs are reported (not all files).
- [ ] Given `getSnapshot()` is called on the SpecPoller, when the snapshot is returned, then it contains the current tree SHA and per-file entries (blob SHA + frontmatter status).
- [ ] Given the SpecPoller detects changes, when it builds the batch result, then `commitSHA` is the HEAD commit SHA of the default branch (fetched via `git.getRef`).
- [ ] Given the SpecPoller completes a poll cycle, when the results are returned to the Engine Core, then the batch is returned synchronously (not via events), including an empty `changes` array when no changes are detected.

## Dependencies

- `control-plane-engine.md` — Parent engine spec (architecture, GitHubClient, event types, dispatch logic, configuration)
- `control-plane-engine-planner-cache.md` — Planner Cache (provides initial snapshot seed to SpecPoller)

## References

- [control-plane-engine.md: Architecture](./control-plane-engine.md#architecture) — Engine layering diagram
- [control-plane-engine.md: Dispatch Logic](./control-plane-engine.md#dispatch-logic) — How poller results drive dispatch decisions
- [control-plane-engine.md: Configuration](./control-plane-engine.md#configuration) — IssuePoller and SpecPoller configuration settings
- `control-plane-engine-recovery.md` — Startup recovery completes before first poll cycle
