---
title: Control Plane Engine — Spec Poller
version: 0.4.0
last_updated: 2026-02-12
status: approved
---

# Control Plane Engine — Spec Poller

## Overview

The SpecPoller monitors the specs directory on the default branch for changes, using the GitHub
Trees API. It is a pure sensor — it detects state changes and returns batch results to the Engine
Core. It does not make dispatch decisions.

## Constraints

- Must not make dispatch decisions or emit notifications. The SpecPoller reports state changes; the
  Engine Core decides what to do about them.
- Detects changes remotely via the GitHub API, not from the local filesystem.
- SpecPoller errors are non-fatal — the engine continues operating.

## Specification

### Poll Cycle

The SpecPoller runs on its own interval.

**Poll cycle steps:**

1. Fetch the tree SHA of the specs directory on the default branch via `GitHubClient`.
2. Compare the tree SHA against the snapshot.
3. If unchanged — notify the Engine Core with an empty batch (`changes: []`). No further API calls
   are made for this cycle.
4. If changed — fetch the full tree. Compare each entry's blob SHA against the snapshot's per-file
   entries to classify changes: entries absent from the snapshot are additions, entries with a
   different blob SHA are modifications, entries present in the snapshot but absent from the tree
   are removals.
5. For each added or modified file, fetch its content via `repos.getContent` (returns base64-encoded
   content), decode it, and parse the frontmatter `status` value.
6. Fetch the HEAD commit SHA of the default branch via `git.getRef` (for spec diff URLs in the TUI).
   This is the current HEAD commit, not necessarily the specific commit that modified each spec file
   (see [Known Limitations](#known-limitations)).
7. Return the complete batch of changes to the Engine Core.
8. Update the snapshot.

The SpecPoller returns results synchronously to the Engine Core on every cycle, even when no changes
are detected (empty `changes` array). When `changes` is non-empty, the Engine Core emits individual
`specChanged` events per file (for the TUI's notification history) and separately passes the full
batch of approved spec paths to the dispatch logic for a single Planner invocation. The per-file
events are not the input to Planner dispatch — the Engine Core passes the batch directly.

> **Rationale:** Returning results on every cycle (including empty batches) ensures the Engine Core
> can dispatch deferred Planner paths on any cycle (see Planner concurrency guard in
> [control-plane-engine.md: Dispatch Logic](./control-plane-engine.md#dispatch-logic)), not only
> when the SpecPoller detects changes. Returning the batch synchronously (rather than via events)
> ensures the Engine Core has the complete set before making dispatch decisions.

### Snapshot State

| Field            | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| Tree SHA         | SHA of the specs directory tree on the default branch      |
| Per-file entries | Map of file path → blob SHA and frontmatter `status` value |

> **Rationale:** The tree SHA comparison makes the common case (nothing changed) a single API call.
> Detailed file inspection only happens when the tree SHA differs.

**Snapshot seeding:** The SpecPoller accepts an optional initial snapshot (tree SHA and per-file
entries) via its constructor. When provided, the snapshot starts with the seeded state instead of
empty. This enables the Planner Cache (see
[control-plane-engine-planner-cache.md](./control-plane-engine-planner-cache.md)) to prevent
redundant Planner runs on engine restart — the SpecPoller compares blob SHAs against the seeded
state and only reports files that actually changed. If no seed is provided, the snapshot starts
empty (existing behavior).

**Snapshot access:** The SpecPoller exposes a `getSnapshot()` method that returns the current
snapshot state (tree SHA and per-file entries) as a `SpecPollerSnapshot`. The Engine Core uses this
at Planner dispatch time to capture the state for the Planner Cache.

**Write precondition:** The `specsDirTreeSHA` in the SpecPoller snapshot is non-null after any
successful tree fetch. The Planner Cache is only written when a Planner is successfully dispatched,
which requires at least one successful SpecPoller cycle — so `specsDirTreeSHA` is guaranteed
non-null at cache write time. See
[control-plane-engine-planner-cache.md](./control-plane-engine-planner-cache.md) for the write
precondition.

**Removed specs:** If a spec file is deleted, the SpecPoller removes it from its per-file snapshot.
No `specChanged` event is emitted for removals — existing task issues for the removed spec are
unaffected. The Planner is not notified of removals.

> **Rationale:** The IssuePoller reports changes via callbacks (push: `onIssueStatusChanged`,
> `onIssueRemoved`) for real-time event delivery to the Engine Core. The SpecPoller returns batch
> results synchronously from `poll()` (pull) to enable reliable Planner batching — the Engine Core
> needs the complete batch before making dispatch decisions.

**First-cycle execution:** `Engine.start()` runs the first poll cycle of each poller as a direct
invocation, not via the interval timer. It awaits all first cycles before resolving. Interval-based
polling begins after the first cycles complete.

### Type Definitions

```ts
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
  changeType: "added" | "modified";
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

- [ ] Given the SpecPoller is running, when its poll interval elapses, then it fetches the tree SHA
      of the specs directory on the default branch via the GitHub API.
- [ ] Given the SpecPoller detects the tree SHA is unchanged, when the poll cycle completes, then no
      further API calls are made and the Engine Core receives an empty batch.
- [ ] Given the SpecPoller detects the tree SHA changed, when it inspects the tree, then it compares
      blob SHAs against its snapshot to identify additions, modifications, and removals, and reads
      frontmatter status for added and modified files only.
- [ ] Given the SpecPoller detects an added or modified spec file, when it fetches the file content,
      then it parses the YAML frontmatter to extract the `status` value.
- [ ] Given the SpecPoller detects a removed spec file, when the cycle completes, then the file is
      removed from the per-file snapshot and no `specChanged` event is emitted for the removal.
- [ ] Given `Engine.start()` is called, when the first SpecPoller cycle runs, then it is executed as
      a direct invocation (not via the interval timer) and `start()` awaits its completion before
      resolving.
- [ ] Given the SpecPoller is constructed with an initial snapshot seed, when the first poll cycle
      runs, then only files with changed blob SHAs are reported (not all files).
- [ ] Given `getSnapshot()` is called on the SpecPoller, when the snapshot is returned, then it
      contains the current tree SHA and per-file entries (blob SHA + frontmatter status).
- [ ] Given the SpecPoller detects changes, when it builds the batch result, then `commitSHA` is the
      HEAD commit SHA of the default branch (fetched via `git.getRef`).
- [ ] Given the SpecPoller completes a poll cycle, when the results are returned to the Engine Core,
      then the batch is returned synchronously (not via events), including an empty `changes` array
      when no changes are detected.

## Known Limitations

- **Commit SHA is HEAD, not per-file.** The `commitSHA` in `SpecPollerBatchResult` is the HEAD
  commit of the default branch at poll time, not the specific commit that modified each spec file.
  If multiple commits were pushed between poll cycles, the diff URL shows the HEAD commit's full
  diff, not a per-file change view. Acceptable because the notification identifies the changed file
  path, giving the user enough context to find the relevant changes.

## Dependencies

- [control-plane-engine.md](./control-plane-engine.md) — Parent engine spec (architecture,
  GitHubClient, event types, dispatch logic, configuration)
- [control-plane-engine-planner-cache.md](./control-plane-engine-planner-cache.md) — Planner Cache
  (provides initial snapshot seed to SpecPoller)

## References

- [control-plane-engine.md: Architecture](./control-plane-engine.md#architecture) — Engine layering
  diagram
- [control-plane-engine.md: Dispatch Logic](./control-plane-engine.md#dispatch-logic) — How poller
  results drive dispatch decisions
- [control-plane-engine.md: Configuration](./control-plane-engine.md#configuration) — SpecPoller
  configuration settings
