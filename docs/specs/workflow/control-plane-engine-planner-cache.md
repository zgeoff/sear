---
title: Control Plane Engine — Planner Cache
version: 0.4.0
last_updated: 2026-02-12
status: approved
---

# Control Plane Engine — Planner Cache

## Overview

The engine persists a lightweight cache to prevent redundant Planner runs across restarts. Without
this cache, the SpecPoller starts with an empty snapshot on each engine initialization, causing all
approved specs to appear as new changes and triggering a full Planner dispatch.

## Constraints

- The cache file is machine-local ephemeral state — it must be gitignored.
- Cache corruption or absence must not prevent engine startup — treat as cold start.
- Cache write failures are non-fatal.

## Specification

**Cache file:** `.agentic-workflow-cache.json` at `repoRoot` (see
[control-plane-engine.md: Repository Root Resolution](./control-plane-engine.md#repository-root-resolution)).
This file should be gitignored — it is machine-local ephemeral state, not shared across clones.

**Format:**

```json
{
  "specsDirTreeSHA": "abc123def456...",
  "commitSHA": "fedcba987654...",
  "files": {
    "docs/specs/workflow/control-plane.md": {
      "blobSHA": "def456...",
      "frontmatterStatus": "approved"
    },
    "docs/specs/auth.md": {
      "blobSHA": "ghi789...",
      "frontmatterStatus": "draft"
    }
  }
}
```

The cache stores the SpecPoller's snapshot at the time the Planner was last successfully dispatched:
the specs directory tree SHA, per-file blob SHAs with frontmatter status, and the commit SHA from
the `SpecPollerBatchResult`. The `commitSHA` field is used as the "previous" commit SHA when
building the Planner's enriched trigger prompt (see
[control-plane-engine-agent-manager.md: Planner Context Pre-computation](./control-plane-engine-agent-manager.md#planner-context-pre-computation))
— it enables the Planner to compute diffs between the last planned state and the current state. The
on-disk format is a JSON serialization of `PlannerCacheEntry` (see
[Type Definitions](#type-definitions) below).

### Startup Seeding

On engine initialization, before startup recovery:

1. Attempt to read `.agentic-workflow-cache.json` from `repoRoot`.
2. If the file exists and contains valid JSON matching the `PlannerCacheEntry` schema, extract the
   `snapshot` and pass it to the SpecPoller as the initial snapshot seed. Retain the `commitSHA` for
   use in the Planner's enriched trigger prompt.
3. The SpecPoller uses the seed as its starting snapshot, so the first poll cycle compares the
   current tree SHA and per-file blob SHAs against the seeded state. Only files that actually
   changed since the last successful Planner run are reported.
4. If the file is missing, unreadable, or contains invalid JSON, treat as a cold start — the
   SpecPoller starts with an empty snapshot (existing behavior). Log at `debug` level (a missing
   cache is normal on first run).

The startup sequence becomes: load planner cache → startup recovery → start pollers.

### Cache Write

When the Engine Core dispatches the Planner, it calls `getSnapshot()` on the SpecPoller and stores
the result along with the `commitSHA` from the `SpecPollerBatchResult`. When the Planner session
completes successfully (`agentCompleted`), the Engine Core writes the stored snapshot and commit SHA
to the cache file. The snapshot is captured at dispatch time, not at completion time.

> **Rationale:** This ensures changes detected by the SpecPoller during the Planner's run (which go
> to the deferred buffer) are not incorrectly marked as planned.

### Behavior by Scenario

| Scenario                       | Behavior                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Restart, no spec changes       | Tree SHA matches cache → SpecPoller reports no changes → Planner not dispatched                                                     |
| Restart, some specs changed    | Tree SHA differs → SpecPoller compares blob SHAs → only changed files reported → Planner dispatched for changed approved specs only |
| Restart, one spec changed      | Same as above — only the one changed file is reported and planned                                                                   |
| First-ever run (no cache file) | Cold start → existing behavior                                                                                                      |
| Cache file corrupt/unreadable  | Treated as cold start                                                                                                               |
| Planner fails                  | Cache not updated → next restart uses previous cache → changes re-detected and re-planned                                           |

### Deferred Paths Interaction

If the Planner succeeds but changes were deferred during its run, the cached snapshot reflects the
state at dispatch time (before the deferred changes were detected). On the next restart, the
SpecPoller compares the current tree against the cached snapshot. Files that changed after the
cached snapshot (including the deferred changes) have different blob SHAs and are detected and
planned.

### Module Location

The Planner Cache logic lives in `engine/planner-cache/`. The module contains:

- `types.ts` — `PlannerCacheEntry` and `PlannerCache` types.
- `create-planner-cache.ts` — Factory function implementing `load()` and `write()`.

### Cache Write Errors

If the cache file cannot be written (permissions, disk full), log at `error` level and continue. The
engine operates correctly without the cache — the next restart will perform a full Planner run. This
is non-fatal.

### Type Definitions

```ts
interface PlannerCacheEntry {
  snapshot: SpecPollerSnapshot;
  commitSHA: string;
}

type PlannerCache = {
  load(): Promise<PlannerCacheEntry | null>; // returns null on miss/error (cold start)
  write(snapshot: SpecPollerSnapshot, commitSHA: string): Promise<void>; // non-fatal on failure
};

// createPlannerCache(repoRoot: string): PlannerCache
```

The `SpecPollerSnapshot` type is defined in
[control-plane-engine-pollers.md: Type Definitions](./control-plane-engine-pollers.md#type-definitions).
`PlannerCacheEntry` pairs the snapshot with the commit SHA from the `SpecPollerBatchResult` —
`load()` returns both so the engine can seed the SpecPoller and build the Planner's enriched prompt.
`write()` takes them as separate parameters since they come from different sources at dispatch time
(snapshot from `getSnapshot()`, commitSHA from `SpecPollerBatchResult`).

The `write()` method requires `snapshot.specsDirTreeSHA` to be non-null — the planner cache is only
written when the SpecPoller has a non-null tree SHA (i.e., after a successful tree fetch). Calling
`write()` with a null `specsDirTreeSHA` is a programming error — enforce with `tiny-invariant` at
the top of `write()`.

## Acceptance Criteria

- [ ] Given the engine starts with a valid `.agentic-workflow-cache.json`, when the SpecPoller runs
      its first cycle and the current tree SHA matches the cached value, then the Planner is not
      dispatched.
- [ ] Given the engine starts with a valid `.agentic-workflow-cache.json`, when the SpecPoller runs
      its first cycle and the current tree SHA differs, then only files with changed blob SHAs are
      reported as changes (not all files).
- [ ] Given the engine starts with a valid `.agentic-workflow-cache.json` and one spec file has a
      different blob SHA, when the SpecPoller runs its first cycle, then only that one file is
      included in the Planner batch.
- [ ] Given the engine starts with no `.agentic-workflow-cache.json` file, when the SpecPoller runs
      its first cycle, then all specs are treated as new (existing cold start behavior).
- [ ] Given the engine starts with a corrupt or unreadable `.agentic-workflow-cache.json`, when the
      cache is loaded, then it is treated as a cold start and logged at `debug` level.
- [ ] Given a Planner session completes successfully, when the `agentCompleted` event fires, then
      `.agentic-workflow-cache.json` is written with the `SpecPollerSnapshot` and `commitSHA`
      captured at dispatch time.
- [ ] Given a Planner session fails, when the `agentFailed` event fires, then
      `.agentic-workflow-cache.json` is not updated.
- [ ] Given changes were deferred during a Planner run, when the Planner completes and the cache is
      written, then the cached snapshot reflects the dispatch-time state, ensuring deferred changes
      are re-detected on restart.
- [ ] Given the cache file cannot be written, when a write error occurs, then the error is logged at
      `error` level and the engine continues operating.
- [ ] Given the engine starts, when the startup sequence runs, then the planner cache is loaded
      before startup recovery and before the SpecPoller's first poll cycle.
- [ ] Given the Planner is dispatched, when the SpecPoller snapshot is captured for the cache, then
      `specsDirTreeSHA` is non-null.

## Dependencies

- `control-plane-engine.md` — Parent engine spec (Repository Root Resolution, SpecPoller dispatch)
- `control-plane-engine-pollers.md` — SpecPoller snapshot seeding and `getSnapshot()` method

## References

- [control-plane-engine-pollers.md: SpecPoller](./control-plane-engine-pollers.md#specpoller) —
  Snapshot seeding and access
- [control-plane-engine.md: Dispatch Logic](./control-plane-engine.md#dispatch-logic) — Planner
  concurrency guard and deferred paths
