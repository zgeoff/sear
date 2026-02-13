---
title: Control Plane Engine — PR Poller
version: 0.1.1
last_updated: 2026-02-13
status: approved
---

# Control Plane Engine — PR Poller

## Overview

The PR Poller monitors all open pull requests in the repository, tracking PR metadata and CI
pipeline status. It is a pure sensor — it detects state changes and reports them via callbacks. It
has no knowledge of issues, dispatch logic, or the TUI. The Engine Core correlates PR data with
tracked issues and determines what actions to take.

## Constraints

- A failure in the PR Poller does not affect other pollers.
- Must not make dispatch decisions or emit notifications. The PR Poller reports state changes; the
  Engine Core decides what to do about them.
- Must not import or reference other poller or TUI modules.
- Uses existing `GitHubClient` methods (`pulls.list`, `repos.getCombinedStatusForRef`,
  `checks.listForRef`) — no new GitHub API surface.
- PR Poller errors are non-fatal — the engine continues operating.
- Nullable string fields from the GitHub API (`body`, `user.login`) are coerced to empty string —
  snapshot fields are never `null` (consistent with the engine's query normalization rules).

## Specification

### Poll Cycle

The PR Poller runs on its own interval (default 30s). Interval-based polling begins after
`Engine.start()` runs the first cycle as a direct invocation and it completes.

**Poll cycle steps:**

1. Fetch all open PRs via `GitHubClient.pulls.list({ owner, repo, state: 'open', per_page: 100 })`.
   The response includes draft PRs — the PR Poller tracks all open PRs regardless of draft status.
2. Update the snapshot: add new PRs (with all fields from the response, `ciStatus: null`) and call
   `onPRDetected` for each new PR, update non-CI metadata for existing PRs (title, url, author,
   body), remove PRs no longer in the response (closed or merged). For existing PRs, `headSHA` is
   NOT updated in this step — it is updated alongside `ciStatus` in step 6 to keep the skip
   optimization consistent. New PRs receive `headSHA` from the response at insertion time.
3. For each PR in the snapshot, determine whether a CI status fetch is needed by comparing the
   current `head.sha` from the response against the stored `headSHA` (see
   [CI Status Monitoring](#ci-status-monitoring) for the skip optimization).
4. For each PR requiring a CI fetch, derive CI status from `repos.getCombinedStatusForRef` and
   `checks.listForRef` using the PR's `head.sha` from the response (see
   [CI Status Monitoring](#ci-status-monitoring) for derivation rules).
5. Compare derived CI status against the stored value. If changed, report the transition to the
   Engine Core via callback.
6. Update the snapshot: set `headSHA` and `ciStatus` for all PRs that had a CI fetch. For PRs where
   the CI fetch was skipped (step 3), `headSHA` and `ciStatus` remain unchanged.

**First-cycle execution:** `Engine.start()` runs the first poll cycle of the PR Poller as a direct
invocation (not via the interval timer) and awaits it before resolving. This detects existing CI
failures at startup.

> **Rationale:** The TUI receives the initial PR and CI state before `start()` resolves, consistent
> with the startup contract in
> [control-plane-engine.md: Engine Interface](./control-plane-engine.md#type-definitions).

**Error handling:** If the `pulls.list` call fails (GitHub API error), the entire poll cycle is
skipped. Logged at `error` level. Retry next cycle. If a CI status fetch fails for an individual PR,
that PR is skipped — other PRs proceed normally. Logged at `error` level. The snapshot retains the
previous entry for skipped PRs.

### Snapshot State

The PR Poller maintains a snapshot of all open PRs:

| Field      | Type                                          | Description                                     |
| ---------- | --------------------------------------------- | ----------------------------------------------- |
| `number`   | `number`                                      | PR number                                       |
| `title`    | `string`                                      | PR title                                        |
| `url`      | `string`                                      | PR URL (`html_url`)                             |
| `headSHA`  | `string`                                      | Head commit SHA                                 |
| `author`   | `string`                                      | PR author login                                 |
| `body`     | `string`                                      | PR body (used by Engine Core for issue linkage) |
| `ciStatus` | `'pending' \| 'success' \| 'failure' \| null` | Derived CI status (`null` before first fetch)   |

The snapshot is a `Map<number, PRSnapshotEntry>` keyed by PR number.

**Snapshot access:** The PR Poller exposes a `getSnapshot()` method that returns the current
snapshot. The Engine Core uses this for issue↔PR correlation.

### CI Status Monitoring

On each poll cycle, the PR Poller checks CI status for tracked PRs. To minimize API calls, a skip
optimization is applied:

**Skip optimization:** Compare the current `head.sha` (from the `pulls.list` response) against the
stored `headSHA`:

- SHA unchanged and `ciStatus` is `'success'` → skip (passing CI cannot fail without new commits)
- SHA unchanged and `ciStatus` is `'pending'` or `'failure'` → fetch (check may have completed or
  been re-run)
- SHA changed → always fetch
- `ciStatus` is `null` (first detection) → always fetch

> **Rationale:** In steady state, most PRs have passing CI with no new commits. The skip
> optimization reduces API calls from 2×N per cycle (where N is open PRs) to 2×M (where M is PRs
> with pending/failed CI, new commits, or first detection).

**CI status derivation:** The `failure`/`pending`/`success` classification uses the same rules as
`getPRForIssue`. See
[control-plane-engine.md: Query Interface](./control-plane-engine.md#query-interface) for the
normative definition.

### Change Reporting

The PR Poller reports changes to the Engine Core via callbacks.

| Callback            | Parameters                                                          | When                                       |
| ------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| `onCIStatusChanged` | PR number, old CI status (`null` on first detection), new CI status | CI status transitioned for a PR            |
| `onPRDetected`      | PR number                                                           | New PR detected (not in previous snapshot) |
| `onPRRemoved`       | PR number                                                           | PR no longer in `pulls.list` response      |

**`onCIStatusChanged`** is called for every CI status transition, including first detection
(`oldCIStatus: null`). The Engine Core decides whether to emit events based on issue linkage.

**`onPRDetected`** is called when a PR appears in the `pulls.list` response that was not in the
previous snapshot. The Engine Core uses this to perform closing-keyword matching and emit `prLinked`
events when appropriate. See
[control-plane-engine.md: PR linkage detection](./control-plane-engine.md#ci-failure-handling).

**`onPRRemoved`** is called when a PR that was in the snapshot is absent from the current
`pulls.list` response (closed or merged). The Engine Core handles cleanup (clearing CI state from
the linked issue, if any).

> **Rationale:** Callbacks (push model) enable real-time event delivery to the Engine Core without
> requiring the caller to poll for results.

### Type Definitions

```ts
type PRSnapshotEntry = {
  number: number;
  title: string;
  url: string;
  headSHA: string;
  author: string;
  body: string;
  ciStatus: "pending" | "success" | "failure" | null; // null before first CI fetch
};

type PRPollerSnapshot = Map<number, PRSnapshotEntry>;

type PRPoller = {
  poll(): Promise<void>; // runs one poll cycle
  getSnapshot(): PRPollerSnapshot;
  stop(): void; // stops the interval timer
};

type PRPollerConfig = {
  gitHubClient: GitHubClient;
  owner: string;
  repo: string;
  pollInterval: number; // seconds
  onCIStatusChanged: (
    prNumber: number,
    oldCIStatus: "pending" | "success" | "failure" | null,
    newCIStatus: "pending" | "success" | "failure",
  ) => void;
  onPRDetected: (prNumber: number) => void;
  onPRRemoved: (prNumber: number) => void;
};

// createPRPoller(config: PRPollerConfig): PRPoller
```

## Acceptance Criteria

### Poll Cycle

- [ ] Given the PR Poller runs its first cycle with an empty snapshot, when PRs are detected, then
      each is added to the snapshot.
- [ ] Given `Engine.start()` is called, when the first PR Poller cycle runs, then it is executed as
      a direct invocation (not via the interval timer) and `start()` awaits its completion before
      resolving.
- [ ] Given the `pulls.list` call fails during a poll cycle, when the error occurs, then the cycle
      is skipped and other pollers continue operating.
- [ ] Given a CI status fetch fails for one PR, when the error occurs, then other PRs proceed
      normally and the failed PR retains its previous snapshot entry.

### Snapshot

- [ ] Given open PRs exist, when the PR Poller completes a cycle, then the snapshot contains an
      entry for each open PR with number, title, URL, head SHA, author, body, and CI status.
- [ ] Given a PR was in the previous snapshot but is absent from the current `pulls.list` response,
      when the PR Poller processes the cycle, then the PR is removed from the snapshot and
      `onPRRemoved` is called.
- [ ] Given `getSnapshot()` is called, when the snapshot is returned, then it contains the current
      state of all tracked PRs.
- [ ] Given a PR's title or body changes between cycles, when the PR Poller processes the cycle,
      then the snapshot entry reflects the updated metadata.
- [ ] Given a PR has a `null` body from the GitHub API, when it is added to the snapshot, then
      `body` is stored as empty string.

### CI Status Monitoring

- [ ] Given a PR has the same `head.sha` as the stored value and `ciStatus` is `'success'`, when the
      CI check runs, then the CI status fetch is skipped for that PR.
- [ ] Given a PR has the same `head.sha` but `ciStatus` is `'pending'`, when the CI check runs, then
      the CI status fetch still executes.
- [ ] Given a PR has the same `head.sha` but `ciStatus` is `'failure'`, when the CI check runs, then
      the CI status fetch still executes.
- [ ] Given a PR's `head.sha` changed since the last cycle, when the CI check runs, then the CI
      status fetch executes regardless of the stored `ciStatus`.
- [ ] Given a PR is newly detected (not in the previous snapshot), when the CI check runs, then the
      CI status fetch executes and `onCIStatusChanged` is called with `oldCIStatus: null`.
- [ ] Given a newly detected PR has CI status `'pending'`, when the first CI fetch completes, then
      `onCIStatusChanged` is called with `oldCIStatus: null` and `newCIStatus: 'pending'`.
- [ ] Given a PR's CI status fetch fails, when the next cycle runs with the same `head.sha`, then
      the skip optimization compares against the stored (stale) `headSHA` and re-attempts the fetch.

### Change Reporting

- [ ] Given a PR's CI status changes from `'success'` to `'failure'`, when the PR Poller detects the
      change, then `onCIStatusChanged` is called with the old and new values.
- [ ] Given a PR's CI status is `'pending'` and transitions to `'success'`, when the PR Poller
      detects the change, then `onCIStatusChanged` is called.
- [ ] Given a PR appears in the `pulls.list` response that was not in the previous snapshot, when
      the PR Poller processes the cycle, then `onPRDetected` is called with the PR number.
- [ ] Given a PR is removed from the `pulls.list` response, when the PR Poller processes the cycle,
      then `onPRRemoved` is called with the PR number and no `onCIStatusChanged` is called.

## Known Limitations

- **Pagination capped at 100 PRs.** `pulls.list` uses `per_page: 100` without pagination.
  Repositories with more than 100 open PRs will have results silently truncated.

## Dependencies

- [control-plane-engine.md](./control-plane-engine.md) — Parent engine spec (`GitHubClient`,
  `getPRForIssue` CI derivation logic, event emitter, configuration)

## References

- [control-plane-engine.md: Query Interface](./control-plane-engine.md#query-interface) —
  `getPRForIssue` CI status derivation rules
- [control-plane-engine.md: Pollers](./control-plane-engine.md#pollers) — Engine poller architecture
- [control-plane-tui.md](./control-plane-tui.md) — TUI store (consumes PR Poller data via Engine
  Core events)
