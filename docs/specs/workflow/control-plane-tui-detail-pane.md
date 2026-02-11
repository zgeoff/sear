---
title: Control Plane TUI — Detail Pane
version: 0.3.1
last_updated: 2026-02-11
status: approved
---

# Control Plane TUI — Detail Pane

## Overview

The detail pane displays context-aware content based on the currently selected issue in the issue list. Content changes automatically as the user navigates the issue list. The pane supports issue details, live agent output streaming, PR summaries, failure overlays, and an empty state — all within a scroll-windowed view.

## Constraints

- Detail pane content must not exceed the terminal viewport. The visible row count is `stdout.rows - 2` (terminal height minus top and bottom border rows).
- Lines exceeding the pane width are truncated with a trailing ellipsis — no line wrapping occurs.
- Agent stream buffers are capped at 10,000 lines per issue (ring buffer).
- Data fetching uses stale-while-revalidate caching — stale data is shown immediately while a background re-fetch updates it.

## Specification

### Pane Header

Like list-based panes, the detail pane's label (`DETAILS`) is embedded in the top border line in full caps. The label is fixed — it never scrolls off-screen. Chrome for the detail pane is exactly 2 rows (top border line + bottom border line).

### Scroll Windowing

The visible row count is `stdout.rows - 2` (terminal height minus chrome). Only that many lines are rendered at a time — content beyond the visible window is not rendered. All detail pane views (issue details, streaming output, PR summary, failure overlay, empty state) are subject to this constraint. When content exceeds the visible row count, the user scrolls within the pane using keyboard controls (`↑`/`↓`/`j`/`k`) or mouse scroll wheel. Both keyboard and mouse scroll move the viewport by one row per key press or scroll tick (the detail pane has no selected item, so there is no snap-back behavior). During streaming, mouse scroll up pauses auto-scroll, same as keyboard scroll. On terminal resize, the visible row count is recomputed from the new `stdout.rows`.

### Line Truncation

Each line in the detail pane occupies exactly one terminal row. Lines exceeding the pane width are truncated with a trailing ellipsis (`…`). This preserves the 1:1 mapping between buffer indices and terminal rows — no line wrapping occurs.

### Content by Issue State

| Selected Issue State | Detail Pane Content | Data Source |
|---------------------|---------------------|-------------|
| `pending`, `unblocked`, `needs-changes` | Issue details: objective, spec reference, scope, acceptance criteria | `getIssueDetails` query (cached in `issueDetails`) |
| `in-progress` (agent running) | Live streaming Implementor output | `getAgentStream` stream accessor (buffered in `agentStreams`) |
| `review` (Reviewer running) | Live streaming Reviewer output | `getAgentStream` stream accessor (buffered in `agentStreams`) |
| `review` (no agent) | PR summary — title, changed files count, CI status | `getPRForIssue` query (cached in `prDetails`) |
| `needs-refinement`, `blocked` | Issue details + resolution guidance | `getIssueDetails` query (cached in `issueDetails`) + `TrackedIssue.resolutionGuidance` |
| `approved` | PR summary — ready for merge | `getPRForIssue` query (cached in `prDetails`) |
| Failed (TUI overlay) | Error details, session ID, branch name (if Implementor or Reviewer), log file path (if present), retry prompt | `lastFailure` from Zustand store |
| No issue selected (`selectedIssue` is `null`) | Empty state: "No issue selected" | N/A |

### On-Demand Fetching

When the user selects an issue, the store checks its `issueDetails`/`prDetails` caches. If the data is not cached, it calls the engine's query interface to fetch it. A spinner with "Loading…" text is shown in the detail pane while the fetch is in progress.

**Null PR result:** When `getPRForIssue` returns `null` (no linked PR found), the detail pane displays "No PR found" as a static message. The null result is not cached in `prDetails` — the absence of an entry means "not yet fetched or no linked PR". On the next view, the store re-fetches. This avoids caching a stale "no PR" result when a PR is created shortly after the issue enters `review` or `approved` status.

### Agent Output Streaming

When viewing a running agent, the detail pane renders from the `agentStreams` buffer. Each entry in the buffer is one terminal line (see Agent Stream Lifecycle for the split contract). The windowing operates on buffer index, not raw character offsets. When auto-scroll is active, the viewport is pinned to the tail of the buffer: the last `visible row count` lines are displayed. The user can scroll up to review earlier output, which pauses auto-scroll. Auto-scroll resumes when the user scrolls the viewport such that the last line in the buffer is visible (viewport offset ≥ buffer length − visible row count).

### Agent Stream Lifecycle

When the engine emits `agentStarted` for an issue, the store clears any existing stream buffer for that issue, then calls `getAgentStream(issueNumber)` on the engine and begins consuming the async iterable. The store splits each yielded chunk on `\n` and discards any trailing empty string from the split (so `"hello\n"` produces `["hello"]`, not `["hello", ""]`). A chunk with no newlines is appended as a single line. Each buffer entry is exactly one terminal line — this guarantees a 1:1 mapping between buffer indices and terminal rows, which the detail pane's scroll windowing depends on. For Planner `agentStarted` events (which have no `issueNumber`), the store skips stream subscription — Planner output is not streamed to the detail pane. When the stream ends (agent completes or fails), the buffer is retained for review until a new agent starts for the same issue or the issue is removed.

### Stream Buffer Limit

Each issue's stream buffer is capped at 10,000 lines. When the buffer exceeds this limit, the oldest lines are dropped (ring buffer). If auto-scroll is paused (the user has scrolled up) and a line is dropped from the front of the buffer, the viewport offset is decremented by one to keep the same content visible. If the offset reaches zero (the user's view has been fully scrolled out by drops), auto-scroll resumes. This prevents unbounded memory growth from verbose agent sessions.

### Stale-While-Revalidate Caching

When `issueStatusChanged` fires, the `issueDetails` and `prDetails` caches for that issue are marked as stale but not cleared. If the user navigates to the issue, the stale cached data is shown immediately while a background re-fetch updates it. If no cached data exists, a loading indicator is shown. This avoids loading-spinner flashes on routine status changes that don't alter the underlying data. If the background re-fetch fails (network error, API error), the stale cached data is retained and the failure is logged. The cache remains marked stale so the next view attempt will retry.

### Failure Overlay

When an issue has a `lastFailure` in the store, the detail pane shows the error state regardless of the GitHub status label. See `control-plane-tui-failure-overlay.md` for full rendering, retry flow, and recovery interaction.

### Type Definitions

```ts
// number, title, and createdAt are available from TrackedIssue; only
// supplemental fields from the engine's IssueDetailsResult are cached here.
type CachedIssueDetails = {
  body: string;
  labels: string[];
  stale: boolean; // marked stale on issueStatusChanged, re-fetched on next view
};

// CachedPRDetails captures the PRDetailsResult fields needed for TUI display
// (see control-plane-engine.md § Query Results), plus a `stale` field for cache
// management. `isDraft` and `headRefName` are omitted — not needed for rendering.
type CachedPRDetails = {
  number: number;
  title: string;
  changedFilesCount: number;
  ciStatus: 'pending' | 'success' | 'failure';
  url: string;
  stale: boolean;
};
```

## Acceptance Criteria

- [ ] Given a pending issue is selected in the issue list, when the detail pane renders, then it displays the issue body (objective, scope, acceptance criteria).
- [ ] Given an issue with a running Implementor is selected, when the detail pane renders, then it streams live Implementor output.
- [ ] Given an issue in `review` with a running Reviewer is selected, when the detail pane renders, then it streams live Reviewer output.
- [ ] Given an issue in `review` with no running Reviewer is selected, when the detail pane renders, then it displays the PR summary.
- [ ] Given a running agent's output is streaming, when new output arrives, then the detail pane auto-scrolls to show the latest output.
- [ ] Given the user scrolls up in the agent stream, when new output arrives, then auto-scroll is paused until the user scrolls back to the bottom.
- [ ] Given a failed issue is selected, when the detail pane renders, then it shows error details, session ID, and the branch name for inspection (Implementor and Reviewer).
- [ ] Given the detail pane displays content that exceeds the visible row count, when the pane renders, then only the visible window of lines is rendered — the pane header remains fixed and the dashboard does not exceed the terminal viewport.
- [ ] Given the detail pane has more content than fits in the visible window, when the user presses `↓`/`j` or `↑`/`k`, then the viewport shifts by exactly one row per key press.
- [ ] Given the user selects an issue, when its detail data is not cached, then the store fetches it via `getIssueDetails` or `getPRForIssue` and shows a loading indicator until the data arrives.
- [ ] Given the user selects an issue, when its detail data is cached but stale, then the cached data is shown immediately while a background re-fetch updates it.
- [ ] Given a stale cache re-fetch fails, when the failure occurs, then the stale data is retained and the cache remains stale for the next view attempt.
- [ ] Given an agent's stream buffer has reached 10,000 lines, when a new line arrives, then the oldest line is dropped and the new line is appended (ring buffer).
- [ ] Given an issue with `status:needs-refinement` is selected, when the detail pane renders, then it displays the issue body and the resolution guidance from `TrackedIssue.resolutionGuidance`.
- [ ] Given an issue with `status:blocked` is selected, when the detail pane renders, then it displays the issue body and the resolution guidance from `TrackedIssue.resolutionGuidance`.
- [ ] Given an issue with `status:approved` is selected, when the detail pane renders, then it displays the PR summary (ready for merge).
- [ ] Given an issue in `review` or `approved` is selected, when `getPRForIssue` returns `null`, then the detail pane displays "No PR found" and the null result is not cached in `prDetails`.
- [ ] Given no issue is selected (`selectedIssue` is `null`), when the detail pane renders, then it displays "No issue selected".
- [ ] Given the detail pane has more content than fits in the visible window, when the user scrolls with the mouse wheel, then the viewport moves by one row per scroll tick.

## Dependencies

- `control-plane-tui.md` — Parent TUI spec (store shape, `agentStreams` state, `issueDetails`/`prDetails` caches, keyboard controls)
- `control-plane-tui-failure-overlay.md` — Failure overlay rendering in the detail pane
- `control-plane-engine.md` — Engine query interface (`getIssueDetails`, `getPRForIssue`), stream accessor (`getAgentStream`)

## References

- `control-plane-tui.md` § State Management — Event handler table, `agentStreams` buffer, cache invalidation
- `control-plane-engine-agent-manager.md` § Stream Accessor — Engine-side stream interface
