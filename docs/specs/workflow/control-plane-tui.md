---
title: Control Plane TUI
version: 0.11.2
last_updated: 2026-02-13
status: approved
---

# Control Plane TUI

## Overview

The TUI is the user-facing module of the control plane. It renders a two-pane dashboard that
surfaces workflow state as a unified task list, provides on-demand agent dispatch, and streams live
agent output. Built with Ink (React for the terminal), the TUI consumes engine events, commands,
queries, and streams via a Zustand store.

The TUI is fully event-driven for task list data — no polling or on-demand fetching is required to
render the list. Detail pane content is fetched on demand when the user pins a task.

## Constraints

- The TUI has no notification system. State changes are reflected in-place on task rows.
- The TUI does not duplicate engine state. Tasks are the sole representation of tracked issues.
- The engine event interface (see [Dependencies](#engine-spec-changes-required)) defines 7 event
  types. The TUI handles all of them. There are no ignored or filtered events.
- The TUI never writes to GitHub. All writes flow through engine commands or agent sessions.
- PRs with no linked issue (no closing keyword in the PR body) are not tracked. This is a known
  limitation.
- The TUI is a consumer of the engine — the engine has no knowledge of the TUI. The dependency is
  strictly one-directional.

## Specification

### Task Model

The TUI represents each tracked issue as a **Task** — a single unit that bundles issue metadata, PR
linkage, CI status, and agent state. Tasks are the sole data model for the task list; there is no
separate notification or issue type.

```ts
type TaskStatus =
  | "ready-to-implement"
  | "agent-implementing"
  | "agent-reviewing"
  | "needs-refinement"
  | "blocked"
  | "ready-to-merge"
  | "agent-crashed";

type Priority = "high" | "medium" | "low";

type CIStatus = "pending" | "success" | "failure";

type AgentType = "implementor" | "reviewer";
```

```ts
interface TaskPR {
  number: number;
  url: string;
  ciStatus: CIStatus | null;
}

interface AgentCrash {
  error: string;
}

interface TaskAgent {
  type: AgentType;
  running: boolean;
  sessionID: string;
  branchName?: string;
  logFilePath?: string;
  crash?: AgentCrash;
}
```

```ts
interface Task {
  issueNumber: number;
  title: string;
  status: TaskStatus;
  statusLabel: string;
  priority: Priority | null;
  agentCount: number;
  createdAt: string;
  prs: TaskPR[];
  agent: TaskAgent | null;
}
```

| Field         | Source                                          | Description                                                                                                                                                                                                                      |
| ------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issueNumber` | `issueStatusChanged`                            | GitHub issue number. Immutable after creation.                                                                                                                                                                                   |
| `title`       | `issueStatusChanged`                            | Issue title. Updated on every `issueStatusChanged`.                                                                                                                                                                              |
| `status`      | Derived                                         | The active `TaskStatus`. Recomputed after every mutation (see [Status Derivation](#status-derivation)).                                                                                                                          |
| `statusLabel` | `issueStatusChanged`                            | Raw engine status label (e.g., `'pending'`, `'review'`). Input to status derivation. Updated on every `issueStatusChanged`.                                                                                                      |
| `priority`    | `issueStatusChanged`                            | Parsed from the engine's `priorityLabel`: `'priority:high'` → `'high'`, etc. `null` if no priority label.                                                                                                                        |
| `agentCount`  | `agentStarted`                                  | Total agent dispatches for this task (implementor + reviewer). Incremented on every `agentStarted`. Starts at `0`. Session-local — not persisted across restarts.                                                                |
| `createdAt`   | `issueStatusChanged`                            | ISO 8601 timestamp from the engine.                                                                                                                                                                                              |
| `prs`         | `prLinked`, `ciStatusChanged`                   | Linked PRs. Empty array until `prLinked` events are received. CI status updated by `ciStatusChanged`. A `ciStatusChanged` for an unknown PR creates a partial entry (empty URL) — see [Event-to-Task Mapping](#cistatuschanged). |
| `agent`       | `agentStarted`, `agentCompleted`, `agentFailed` | Last/current agent for this task. Set on `agentStarted` with full metadata. Updated (not cleared) on `agentCompleted`/`agentFailed`. Set to `null` on human-initiated status change.                                             |

### Status Derivation

`status` is a derived field, recomputed after every task mutation. The derivation evaluates three
inputs in priority order:

**Step 1 — Crash override:** If `agent` is not `null` and `agent.crash` is set, status is
`agent-crashed`.

**Step 2 — Running agent override:** If `agent` is not `null` and `agent.running` is `true`:

- `agent.type === 'implementor'` → `agent-implementing`
- `agent.type === 'reviewer'` → `agent-reviewing`

**Step 3 — Status label mapping:** Derive from `statusLabel`:

| `statusLabel`      | `TaskStatus`         |
| ------------------ | -------------------- |
| `pending`          | `ready-to-implement` |
| `unblocked`        | `ready-to-implement` |
| `needs-changes`    | `ready-to-implement` |
| `in-progress`      | `agent-implementing` |
| `review`           | `agent-reviewing`    |
| `needs-refinement` | `needs-refinement`   |
| `blocked`          | `blocked`            |
| `approved`         | `ready-to-merge`     |

> **Rationale:** The three-step priority ensures crash state is never hidden by a recovery label
> change, and a running agent always overrides the (potentially stale) label from the poller. The
> `statusLabel` mapping is the steady-state path when no agent is active and no crash is recorded.

If `statusLabel` does not match any row in the table, the task is excluded from rendering. This
handles future label additions gracefully without a TUI update.

### Event-to-Task Mapping

The TUI subscribes to all 7 engine event types via `engine.on()`.

After every event that mutates a task, the store recomputes `status` via the derivation rules in
[Status Derivation](#status-derivation).

#### `issueStatusChanged`

Creates, updates, or removes a task by `issueNumber`.

**When `newStatus` is `null` — task removal:**

| Field           | Update                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Task            | Remove from `tasks` map.                                                                                              |
| Caches          | Clear `issueDetailCache` entry for this issue number. Clear `prDetailCache` entries for each PR number in `task.prs`. |
| Stream          | Clear `agentStreams` entry for the task's `agent.sessionID` (if any).                                                 |
| `pinnedTask`    | Set to `null` if this was the pinned task.                                                                            |
| `selectedIssue` | If this was the selected task, set to the next task in sort order. If no tasks remain, set to `null`.                 |

**When `newStatus` is a string — task create/update:**

| Field         | Update                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `title`       | Set to event's `title`.                                                                                       |
| `statusLabel` | Set to event's `newStatus`.                                                                                   |
| `priority`    | Parsed from event's `priorityLabel`.                                                                          |
| `createdAt`   | Set to event's `createdAt`.                                                                                   |
| `agent`       | Set to `null` **only when** `isRecovery` is `false` AND `isEngineTransition` is `false`. Preserved otherwise. |

If no task exists for the `issueNumber`, one is created with `agentCount: 0`, `prs: []`,
`agent: null`.

> **Rationale:** `isRecovery` fires after `agentFailed` + crash recovery. Clearing `agent` would
> discard the crash details, hiding the failure from the user. `isEngineTransition` fires on
> engine-initiated label changes (e.g., `status:review` after Implementor completion). In neither
> case has the user taken action, so the agent state is preserved. A human-initiated status change
> (both flags false) signals that the user addressed the situation externally, so stale agent state
> is cleared.

#### `prLinked`

Adds or updates a PR on an existing task. Lookup by `issueNumber`.

| Field | Update                                                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `prs` | If a PR with matching `prNumber` exists, update it. Otherwise append `{ number: event.prNumber, url: event.url, ciStatus: event.ciStatus }`. |

If no task exists for the event's `issueNumber`, the event is ignored.

> **Rationale:** `prLinked` is a new engine event (see [Dependencies](#dependencies)). The engine
> emits it when the PRPoller detects a PR linked to a tracked issue via closing-keyword matching on
> the PR body. This replaces the on-demand `getPRForIssue` pattern for list data — the TUI is fully
> event-driven for task list rendering.

#### `ciStatusChanged`

Updates CI status on a task's linked PR. Lookup by `issueNumber`.

| Field                    | Update                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `prs[matching].ciStatus` | Find the PR entry with matching `prNumber`. Set its `ciStatus` to event's `newCIStatus`. |

If the event has no `issueNumber`, or no task exists for it, the event is ignored. If no matching PR
exists in `prs`, append a partial entry:
`{ number: event.prNumber, url: '', ciStatus: event.newCIStatus }`.

> **Rationale:** The partial PR (empty URL) ensures CI status is tracked even if `prLinked` hasn't
> fired yet due to poller timing. The URL is populated when `prLinked` arrives or when the user
> fetches PR details on demand.

#### Agent Event Lookup

All three agent events (`agentStarted`, `agentCompleted`, `agentFailed`) carry `sessionID`.

- **Planner events** (`agentType === 'planner'`): toggle `plannerStatus`. No task lookup.
- **`agentStarted`** (Implementor / Reviewer): lookup by `issueNumber` — this is the only agent
  event that uses `issueNumber`, because it establishes the session-to-task binding.
- **`agentCompleted` / `agentFailed`** (Implementor / Reviewer): lookup by `sessionID` — find the
  task where `task.agent?.sessionID === event.sessionID`.

> **Rationale:** `sessionID` is the natural identity for agent work. Using it for lookup decouples
> the session from the issue — the `agentStarted` event establishes the binding, and subsequent
> events reference it by session. If no task matches the `sessionID`, the event is logged and
> skipped.

#### `agentStarted` — Planner

Set `plannerStatus` to `'running'`. No task update.

#### `agentStarted` — Implementor / Reviewer

Lookup by `issueNumber`. Replaces the task's agent with a new instance carrying full metadata.

| Field        | Update                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`      | Set to `{ type: event.agentType, running: true, sessionID: event.sessionID, branchName: event.branchName, logFilePath: event.logFilePath }`. |
| `agentCount` | Increment by 1.                                                                                                                              |
| Stream       | Subscribe to `getAgentStream(event.sessionID)`. Clear existing stream buffer.                                                                |

Task must already exist (created by a prior `issueStatusChanged`). If no task exists, log a warning
and skip.

#### `agentCompleted` — Planner

Set `plannerStatus` to `'idle'`. No task update.

#### `agentCompleted` — Implementor / Reviewer

Lookup by `sessionID`.

| Field           | Update                                                                   |
| --------------- | ------------------------------------------------------------------------ |
| `agent.running` | Set to `false`. Agent object is preserved (metadata remains accessible). |

`status` is not explicitly set — the subsequent `issueStatusChanged` (engine transition or next poll
cycle) will update `statusLabel`, and the derivation will produce the correct status.

#### `agentFailed` — Planner

Set `plannerStatus` to `'idle'`. No task update.

#### `agentFailed` — Implementor / Reviewer

Lookup by `sessionID`.

| Field           | Update                           |
| --------------- | -------------------------------- |
| `agent.running` | Set to `false`.                  |
| `agent.crash`   | Set to `{ error: event.error }`. |

The subsequent `issueStatusChanged(isRecovery: true)` will update `statusLabel` but preserve `agent`
(including its crash state), so status remains `agent-crashed`.

#### `specChanged`

No task update. The Planner handles spec changes autonomously. The TUI does not surface spec
activity in the task list.

### Store

The TUI uses a single Zustand vanilla store. Components read via `useStore(store, selector)`. All
engine event subscriptions and command dispatching go through the store.

#### State

```ts
interface TUIState {
  tasks: Map<number, Task>;
  plannerStatus: "idle" | "running";

  selectedIssue: number | null;
  pinnedTask: number | null;
  focusedPane: "taskList" | "detailPane";
  shuttingDown: boolean;

  agentStreams: Map<string, string[]>;

  issueDetailCache: Map<number, CachedIssueDetail>;
  prDetailCache: Map<number, CachedPRDetail>;
}
```

| Field              | Description                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks`            | All tracked tasks, keyed by issue number. Populated by engine events.                                                                                                                           |
| `plannerStatus`    | Current planner state. Toggled by planner `agentStarted` / `agentCompleted` / `agentFailed`.                                                                                                    |
| `selectedIssue`    | Issue number of the highlighted task in the list. `null` when the list is empty.                                                                                                                |
| `pinnedTask`       | Issue number shown in the detail pane. `null` until the user presses Enter. Independent of `selectedIssue` — pinning locks the detail pane while the user navigates the list.                   |
| `focusedPane`      | Which pane receives keyboard input. Toggled by Tab.                                                                                                                                             |
| `shuttingDown`     | Set to `true` when the user confirms quit. Drives the shutdown overlay.                                                                                                                         |
| `agentStreams`     | Live agent output buffers, keyed by `sessionID`. Each entry is an array of strings (one per terminal row). Capped at 10,000 lines per session (ring buffer — oldest lines dropped on overflow). |
| `issueDetailCache` | On-demand cache for issue body and labels, keyed by issue number. Used by the detail pane.                                                                                                      |
| `prDetailCache`    | On-demand cache for detailed PR data (changed files, reviews, CI checks), keyed by PR number. Used by the detail pane.                                                                          |

```ts
interface CachedIssueDetail {
  body: string;
  labels: string[];
  stale: boolean;
}

interface CachedPRDetail {
  title: string;
  changedFilesCount: number;
  failedCheckNames?: string[];
  stale: boolean;
}
```

Caches use a stale-while-revalidate strategy. Stale data is rendered immediately while a background
re-fetch runs. If no cached data exists, a loading indicator is shown. If the re-fetch fails, stale
data is retained and the entry remains stale for the next attempt.

Stale-marking triggers:

| Cache              | Trigger Event        | Lookup           |
| ------------------ | -------------------- | ---------------- |
| `issueDetailCache` | `issueStatusChanged` | By `issueNumber` |
| `prDetailCache`    | `prLinked`           | By `prNumber`    |
| `prDetailCache`    | `ciStatusChanged`    | By `prNumber`    |

#### Actions

```ts
interface TUIActions {
  dispatch: (issueNumber: number) => void;
  shutdown: () => void;
  selectIssue: (issueNumber: number) => void;
  pinTask: (issueNumber: number) => void;
  cycleFocus: () => void;
}
```

| Action        | Behavior                                                                                                                                                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch`    | Sends a command to the engine based on the task's status. `ready-to-implement` → calls `engine.dispatchImplementor(issueNumber)`. `agent-crashed` → calls `engine.dispatchImplementor(issueNumber)` if `task.agent.type` is `'implementor'`, or `engine.dispatchReviewer(issueNumber)` if `'reviewer'`. No-op for other statuses. |
| `shutdown`    | Sets `shuttingDown: true`. Sends `shutdown` command to the engine.                                                                                                                                                                                                                                                                |
| `selectIssue` | Updates `selectedIssue`. No effect on the detail pane.                                                                                                                                                                                                                                                                            |
| `pinTask`     | Sets `pinnedTask` to the given issue number. Triggers on-demand fetch of issue details and PR details if not cached.                                                                                                                                                                                                              |
| `cycleFocus`  | Toggles `focusedPane` between `'taskList'` and `'detailPane'`.                                                                                                                                                                                                                                                                    |

#### Selectors

```ts
type Section = "action" | "agents";

interface SortedTask {
  task: Task;
  section: Section;
}
```

| Selector            | Returns                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sortedTasks`       | Flattened, sorted array of `SortedTask`. ACTION items first, then AGENTS items. Each section sorted by status weight → priority weight → issue number ascending. See [Task List — Sorting](#sorting). |
| `actionCount`       | Count of tasks in the ACTION section.                                                                                                                                                                 |
| `agentSectionCount` | Count of tasks in the AGENTS section.                                                                                                                                                                 |
| `runningAgentCount` | Count of tasks with `agent?.running === true`, plus 1 if `plannerStatus === 'running'`. Used in the quit confirmation prompt.                                                                         |

### Layout

The TUI renders a fixed-frame terminal UI using Ink (React for the terminal).

#### Structure

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Header                                                           planner 💤 │
├──────────────────────────────────┬───────────────────────────────────────────┤
│ Task List (left pane)            │ Detail Pane (right pane)                  │
│                                  │                                           │
│ ACTION (N)                       │                                           │
│ ...items...                      │                                           │
│ ─────────────────────────────────│                                           │
│ AGENTS (N)                       │                                           │
│ ...items...                      │                                           │
├──────────────────────────────────┴───────────────────────────────────────────┤
│ Footer: keybinding hints                                                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Header Bar

Single row. Right-aligned planner status: the text `planner` followed by a status indicator.

| `plannerStatus` | Indicator          |
| --------------- | ------------------ |
| `'running'`     | Spinner (animated) |
| `'idle'`        | 💤                 |

#### Footer Bar

Single row. Keybinding hints rendered as a horizontal list. Content depends on `focusedPane`:

- **Task list focused:** `↑↓jk select    <enter> pin    [d]ispatch    [o]pen    [c]opy    [q]uit`
- **Detail pane focused:** `↑↓jk scroll    <tab> back    [o]pen    [c]opy    [q]uit`

The `[d]ispatch` hint is **dimmed** when the selected task's status is not `ready-to-implement` or
`agent-crashed`. This signals that the key is contextually unavailable without hiding it from the
layout.

#### Pane Layout

Two vertical panes separated by a box-drawing border.

- **Left pane (task list):** 40% of terminal width, minimum 30 columns.
- **Right pane (detail):** Remainder of terminal width.
- Both panes span the full height between header and footer bars.
- Recomputed on terminal resize.

#### Section Sub-Panes

The left pane is split vertically into two borderless sub-panes of equal height:

- **ACTION** (top) — tasks requiring human intervention.
- **AGENTS** (bottom) — tasks owned by the automated workflow.

Each sub-pane has a header row and an item area:

- **Sub-pane height:** `floor(pane_height / 2)` rows each. When `pane_height` is odd, the extra row
  goes to the ACTION sub-pane (`ceil(pane_height / 2)` for ACTION, `floor(pane_height / 2)` for
  AGENTS).
- **Item capacity:** sub-pane height − 1 (the header row). Items beyond capacity are not rendered.
- **Header format:** `ACTION (N)` or `AGENTS (N)` when all items fit. When items are truncated:
  `ACTION (V/N)` or `AGENTS (V/N)` where V is visible items and N is total.

Both section headers are always rendered, even when the section has zero items (displayed as `(0)`).
This keeps the layout stable.

Section headers are not selectable — keyboard navigation skips them.

There is no scroll mechanism within sections. If the terminal is too short to display all items, the
overflow indicator `(V/N)` signals that items are cut off.

### Task List

#### Row Format

Each task renders as a single terminal row:

```
{issue} {pr} {status} {icon} {title}
```

| Column | Width     | Content                                                             |
| ------ | --------- | ------------------------------------------------------------------- |
| Issue  | 6 chars   | `#` + zero-padded issue number (e.g., `#311`). Colored by priority. |
| PR     | 8 chars   | PR reference or `—`. Colored by CI status.                          |
| Status | 10 chars  | Display label from the status mapping table. `WIP` appends `(N)`.   |
| Icon   | 2 chars   | Status icon.                                                        |
| Title  | Remainder | Issue title, truncated with `…` if it exceeds available width.      |

##### Issue Column — Priority Color

| Priority | Color   |
| -------- | ------- |
| `high`   | Red     |
| `medium` | Yellow  |
| `low`    | Dim     |
| `null`   | Default |

##### PR Column

When `prs` is empty: `—` in dim.

When `prs` has one entry: `PR#` + PR number (e.g., `PR#482`).

When `prs` has multiple entries: `PRx` + count (e.g., `PRx3`).

Color is determined by the **worst CI status** across all entries in `prs`:

| Worst CI Status | Color |
| --------------- | ----- |
| `failure`       | Red   |
| `pending`       | Dim   |
| `success`       | Green |
| all `null`      | Dim   |

Priority order for "worst": `failure` > `pending` > `success` > `null`.

##### Status Column — Display Labels

| `TaskStatus`         | Display    | Icon |
| -------------------- | ---------- | ---- |
| `ready-to-merge`     | `APPROVED` | ✔    |
| `agent-crashed`      | `FAILED`   | 💥   |
| `blocked`            | `BLOCKED`  | ⛔   |
| `needs-refinement`   | `REFINE`   | 📝   |
| `ready-to-implement` | `DISPATCH` | ●    |
| `agent-implementing` | `WIP(N)`   | 🤖   |
| `agent-reviewing`    | `REVIEW`   | 🔎   |

`WIP(N)` renders the task's `agentCount` as a parenthetical suffix.

#### Sorting

Each section is sorted independently using a three-level sort chain:

**Level 1 — Status weight** (descending):

| `TaskStatus`         | Weight |
| -------------------- | ------ |
| `ready-to-merge`     | 100    |
| `agent-crashed`      | 90     |
| `blocked`            | 80     |
| `needs-refinement`   | 70     |
| `ready-to-implement` | 50     |
| `agent-implementing` | 50     |
| `agent-reviewing`    | 50     |

**Level 2 — Priority weight** (descending):

| Priority | Weight |
| -------- | ------ |
| `high`   | 3      |
| `medium` | 2      |
| `low`    | 1      |
| `null`   | 0      |

**Level 3 — Issue number** (ascending): lowest issue number first (oldest issues surface).

#### Section Assignment

A task's section is derived from its status:

| Section | Statuses                                                                               |
| ------- | -------------------------------------------------------------------------------------- |
| ACTION  | `ready-to-merge`, `agent-crashed`, `blocked`, `needs-refinement`, `ready-to-implement` |
| AGENTS  | `agent-implementing`, `agent-reviewing`                                                |

#### Selection and Navigation

`selectedIssue` tracks the highlighted task by issue number. This is stable across re-renders — if
the list order changes due to a status update, the selection stays on the same task. If a re-render
causes the selected task to fall beyond its section's visible capacity, the selection snaps to the
last visible item in that section.

Navigation moves through **visible items only** (items beyond capacity are not reachable). The
selection crosses sections seamlessly:

- ↓ from the last visible ACTION item → first visible AGENTS item. No-op if AGENTS has zero visible
  items.
- ↑ from the first visible AGENTS item → last visible ACTION item. No-op if ACTION has zero visible
  items.
- ↓ from the last visible AGENTS item → no-op.
- ↑ from the first visible ACTION item → no-op.

When `selectedIssue` is `null` (empty list or selected task was removed), the first navigation
keypress selects the first visible task in sort order.

#### Empty States

When a section has zero items, the section header renders with `(0)`. No placeholder text.

When both sections are empty: `selectedIssue` is `null`. Keyboard navigation is a no-op.

### Detail Pane

The right pane displays contextual information for the pinned task. Content is determined by the
pinned task's current `status` — when the status changes, the detail pane switches content
automatically. On any status change, the detail pane's scroll position resets to the top (offset 0).
For agent stream views, this means auto-scroll resumes from the tail.

When `pinnedTask` is `null`, the detail pane renders `No task selected`.

#### Content by Status

| `TaskStatus`         | Content                          | Data Source                                         |
| -------------------- | -------------------------------- | --------------------------------------------------- |
| `ready-to-implement` | Issue body and labels            | `getIssueDetails(issueNumber)` → `issueDetailCache` |
| `agent-implementing` | Live agent output stream         | `agentStreams[agent.sessionID]`                     |
| `agent-reviewing`    | Live agent output stream         | `agentStreams[agent.sessionID]`                     |
| `needs-refinement`   | Issue body and labels            | `getIssueDetails(issueNumber)` → `issueDetailCache` |
| `blocked`            | Issue body and labels            | `getIssueDetails(issueNumber)` → `issueDetailCache` |
| `ready-to-merge`     | PR summary for each linked PR    | `prDetailCache` per PR, fetched on demand           |
| `agent-crashed`      | Crash details and agent metadata | `task.agent` (no fetch needed)                      |

#### Issue Detail View

Displayed for `ready-to-implement`, `needs-refinement`, and `blocked` statuses.

Content:

1. Issue number and title (header).
2. Labels rendered as a comma-separated list.
3. Issue body (markdown rendered as plain text, line-wrapped to pane width).

Data is fetched on demand via `getIssueDetails(issueNumber)` and stored in `issueDetailCache`. While
loading, display the issue number and title with `Loading...` below. Stale-while-revalidate: stale
data is shown immediately while a background re-fetch runs.

#### Agent Stream View

Displayed for `agent-implementing` and `agent-reviewing` statuses.

The stream buffer is read from `agentStreams[task.agent.sessionID]`. Each buffer entry is one
terminal row, rendered 1:1.

**Auto-scroll:** Viewport is pinned to the tail of the buffer (last N lines displayed, where N =
pane height). New lines push the viewport forward.

**Scroll pause:** When the user scrolls up (j/k or mouse), auto-scroll pauses. The viewport stays at
the user's position while new lines continue appending to the buffer.

**Scroll resume:** Auto-scroll resumes when the user scrolls the viewport back to the bottom (offset
≥ buffer length − visible line count).

**Buffer cap:** 10,000 lines per session (ring buffer). When the cap is reached, the oldest line is
dropped. If auto-scroll is paused and a line is dropped from the front, the viewport offset
decrements by 1 to keep the same content visible. If the offset reaches 0, auto-scroll resumes.

**Stream end:** When the agent completes or fails, the stream stops producing new lines. The buffer
is retained and viewable until the status changes away from `agent-implementing` / `agent-reviewing`
or a new agent starts for the same task (which clears the buffer).

#### PR Summary View

Displayed for `ready-to-merge` status.

For each PR in `task.prs`:

1. PR number and title.
2. Changed files count.
3. CI status. If `ciStatus` is `'failure'`, list failed check names (fetched on demand via
   `getCIStatus(prNumber)` and stored in `prDetailCache`).

Data is fetched on demand per PR and stored in `prDetailCache`. While loading, display the PR number
(available from `task.prs`) with `Loading...`.

#### Crash Detail View

Displayed for `agent-crashed` status.

Content read directly from `task.agent`:

1. **Agent type** — `Implementor` or `Reviewer`.
2. **Error message** — from `agent.crash.error`. Rendered in red.
3. **Session ID** — from `agent.sessionID`.
4. **Branch name** — from `agent.branchName` (if present).
5. **Log file** — from `agent.logFilePath` (if present). Rendered as an OSC 8 terminal hyperlink
   (`file://{logFilePath}`).
6. **Retry hint** — `Press [d] to retry`.

No fetch needed — all data is on the task.

#### Detail Pane Scrolling

When the detail pane is focused (via Tab), `j`/`k` and `↑`/`↓` scroll the content vertically.

For static content views (issue detail, PR summary, crash detail): scroll moves the viewport by one
row per keypress. Lines exceeding pane width are truncated (no line wrapping at the viewport level).

For the agent stream view: scroll behaves as described in [Agent Stream View](#agent-stream-view)
(pauses/resumes auto-scroll).

### Keybindings

#### Focus Model

The TUI has two focusable panes: **task list** and **detail pane**. `focusedPane` determines which
pane receives keyboard input. Tab toggles between them.

The task list is focused on startup.

#### Global Keys

These keys are active regardless of which pane is focused.

| Key   | Action                                                                               |
| ----- | ------------------------------------------------------------------------------------ |
| `Tab` | Toggle `focusedPane` between `taskList` and `detailPane`.                            |
| `o`   | Open the relevant URL in the system browser (see [URL Resolution](#url-resolution)). |
| `c`   | Copy the relevant URL to the system clipboard.                                       |
| `q`   | Show quit confirmation prompt.                                                       |

#### Task List Keys

Active when `focusedPane` is `taskList`.

| Key       | Action                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `↑` / `k` | Move selection to previous visible item. No-op at top of ACTION.                                                                                        |
| `↓` / `j` | Move selection to next visible item. No-op at bottom of AGENTS.                                                                                         |
| `Enter`   | Pin the selected task to the detail pane. Sets `pinnedTask` to `selectedIssue`. No-op when `selectedIssue` is `null`.                                   |
| `d`       | Dispatch — show confirmation prompt for the selected task. Only active for `ready-to-implement` and `agent-crashed` statuses. No-op for other statuses. |

#### Detail Pane Keys

Active when `focusedPane` is `detailPane`.

| Key       | Action                          |
| --------- | ------------------------------- |
| `↑` / `k` | Scroll content up by one row.   |
| `↓` / `j` | Scroll content down by one row. |

#### URL Resolution

The `o` and `c` keys resolve a URL from the **target task**: `selectedIssue` when the task list is
focused, `pinnedTask` when the detail pane is focused. If the target is `null`, both keys are
no-ops.

| `TaskStatus`         | URL                                               |
| -------------------- | ------------------------------------------------- |
| `ready-to-implement` | Issue URL                                         |
| `needs-refinement`   | Issue URL                                         |
| `blocked`            | Issue URL                                         |
| `agent-implementing` | Issue URL (or first PR URL if `prs` is non-empty) |
| `agent-reviewing`    | First PR URL (or issue URL if `prs` is empty)     |
| `ready-to-merge`     | First PR URL (or issue URL if `prs` is empty)     |
| `agent-crashed`      | Issue URL                                         |

Issue URL format: `https://github.com/{owner}/{repo}/issues/{issueNumber}`. PR URL format:
`https://github.com/{owner}/{repo}/pull/{prNumber}`.

#### Confirmation Prompts

Confirmation prompts render as a centered overlay. Only one prompt can be active at a time. While a
prompt is visible, all other key handlers are suspended — only `y`, `n`, and `Escape` are active.

##### Dispatch Prompt

Triggered by `d` on a `ready-to-implement` task.

```
Dispatch Implementor for #N? [y/n]
```

On `y`: call `store.dispatch(issueNumber)`. On `n` / `Escape`: dismiss.

##### Retry Prompt

Triggered by `d` on an `agent-crashed` task.

```
Retry {AgentType} for #N? [y/n]
```

`{AgentType}` is `Implementor` or `Reviewer`, read from `task.agent.type`.

On `y`: call `store.dispatch(issueNumber)`. On `n` / `Escape`: dismiss.

##### Quit Prompt

Triggered by `q`.

When agents are running: `Quit? {N} agent(s) running. [y/n]` where N is `runningAgentCount`.

When no agents are running: `Quit? [y/n]`.

On `y`: call `store.shutdown()`. On `n` / `Escape`: dismiss.

### Startup and Shutdown

#### Startup Sequence

1. Initialize the Zustand store.
2. Subscribe to all engine events via `engine.on()` — subscriptions must be registered **before**
   `engine.start()` to avoid missing startup events.
3. Call `engine.start()`. Display a centered loading spinner with `Starting...` text. The two-pane
   layout is not rendered during this phase.
4. On resolution: render the two-pane layout. `focusedPane` is set to `taskList`. `selectedIssue` is
   set to the first task in sort order (or `null` if no tasks). `pinnedTask` is `null`.

#### Shutdown Sequence

1. User presses `q` — quit confirmation shows `runningAgentCount`.
2. On `y`: `shuttingDown` set to `true`. `shutdown` command sent to engine.
3. Display `Shutting down...` overlay. If agents are running, show
   `Shutting down... waiting for {N} agent(s)`. Count updates as agents complete.
4. Process exits when all agents have completed or the engine's shutdown timeout is reached.

## Acceptance Criteria

### Task Lifecycle

- [ ] Given the engine emits `issueStatusChanged` for a new issue, when the TUI receives it, then a
      Task is created with `agentCount: 0`, `prs: []`, `agent: null`
- [ ] Given a task exists and the engine emits `issueStatusChanged` with `newStatus: null`, when the
      TUI receives it, then the task is removed from the store, caches are cleared, and `pinnedTask`
      is nulled if it was the removed task
- [ ] Given a task has `agent.crash` set and the engine emits `issueStatusChanged` with
      `isRecovery: true`, when the TUI processes it, then `agent` is preserved (crash state is not
      cleared) and `status` remains `agent-crashed`
- [ ] Given a task has a running agent and the engine emits `issueStatusChanged` with
      `isRecovery: false` and `isEngineTransition: true`, when the TUI processes it, then `agent` is
      preserved (engine-initiated transition does not clear agent state)
- [ ] Given a task has `agent.crash` set and the engine emits `issueStatusChanged` with both
      `isRecovery` and `isEngineTransition` as `false`, when the TUI processes it, then `agent` is
      set to `null` and status is derived from the new `statusLabel`
- [ ] Given a task is removed via `issueStatusChanged` with `newStatus: null` and it is the
      `selectedIssue`, when the removal is processed, then `selectedIssue` moves to the next task in
      sort order (or `null` if no tasks remain)

### Status Derivation

- [ ] Given a task with `agent.crash` set and `statusLabel: 'pending'`, when status is derived, then
      the result is `agent-crashed` (crash overrides label)
- [ ] Given a task with `agent.running: true` and `agent.type: 'implementor'` and
      `statusLabel: 'pending'`, when status is derived, then the result is `agent-implementing`
      (running agent overrides label)
- [ ] Given a task with `statusLabel` set to an unrecognized value, when the task list renders, then
      the task is excluded from both sections

### Agent Lifecycle

- [ ] Given the engine emits `agentStarted` for a planner, when the TUI receives it, then
      `plannerStatus` is set to `'running'` and no task is created or updated
- [ ] Given the engine emits `agentCompleted` or `agentFailed` for a planner, when the TUI receives
      it, then `plannerStatus` is set to `'idle'`
- [ ] Given the engine emits `agentStarted` for an implementor, when the TUI receives it, then the
      task's `agent` is set with full metadata (`sessionID`, `branchName`, `logFilePath`),
      `agentCount` is incremented, and a stream subscription is started
- [ ] Given the engine emits `agentCompleted`, when the TUI receives it, then the task is found by
      matching `sessionID` on `task.agent`, and `agent.running` is set to `false` (agent object is
      preserved)
- [ ] Given the engine emits `agentFailed`, when the TUI receives it, then the task is found by
      `sessionID`, `agent.running` is set to `false`, and `agent.crash` is set with the error

### Engine Events

- [ ] Given the engine emits `specChanged`, when the TUI receives it, then no task or store state is
      updated

### PR Tracking

- [ ] Given the engine emits `prLinked` for a tracked issue, when the TUI receives it, then the PR
      is appended to `task.prs` (or updated if a matching `prNumber` already exists)
- [ ] Given the engine emits `ciStatusChanged` with an `issueNumber`, when a matching task exists
      but no matching PR exists in `prs`, then a partial PR entry is created with an empty URL
- [ ] Given a task has multiple PRs with mixed CI statuses (one `failure`, one `success`), when the
      task list renders, then the PR column color reflects the worst status (`failure` → red)

### Section Assignment and Sorting

- [ ] Given tasks with statuses `ready-to-merge`, `agent-crashed`, `blocked`, `needs-refinement`,
      and `ready-to-implement`, when the task list renders, then all appear in the ACTION section
- [ ] Given tasks with statuses `agent-implementing` and `agent-reviewing`, when the task list
      renders, then all appear in the AGENTS section
- [ ] Given two ACTION tasks with the same status weight but different priorities, when sorted, then
      the higher-priority task appears first
- [ ] Given two tasks with the same status weight and priority, when sorted, then the lower issue
      number appears first

### Section Sub-Panes

- [ ] Given the ACTION section has more items than its sub-pane capacity, when rendered, then the
      header displays `ACTION (V/N)` where V is visible items and N is total, and excess items are
      not rendered
- [ ] Given the ACTION section has zero items, when rendered, then the header displays `ACTION (0)`
      and the sub-pane is otherwise empty
- [ ] Given the user presses ↓ on the last visible ACTION item, when AGENTS has visible items, then
      the selection moves to the first AGENTS item
- [ ] Given the user presses ↓ on the last visible AGENTS item, when at the bottom edge, then
      nothing happens (no wrap)

### Detail Pane

- [ ] Given no task is pinned, when the detail pane renders, then it displays `No task selected`
- [ ] Given a pinned task with status `agent-implementing`, when the agent completes and status
      changes to `ready-to-merge`, then the detail pane switches from stream view to PR summary view
- [ ] Given a pinned task with status `agent-crashed`, when the detail pane renders, then it
      displays the error message, session ID, branch name, log file link, and retry hint
- [ ] Given a pinned task is removed by `issueStatusChanged` with `newStatus: null`, when the
      removal is processed, then `pinnedTask` is set to `null` and the detail pane shows
      `No task selected`

### Keybindings

- [ ] Given the task list is focused and the selected task has status `ready-to-implement`, when `d`
      is pressed, then a dispatch confirmation prompt is shown
- [ ] Given the task list is focused and the selected task has status `blocked`, when `d` is
      pressed, then nothing happens (no-op)
- [ ] Given a confirmation prompt is visible, when any key other than `y`, `n`, or `Escape` is
      pressed, then the key is ignored
- [ ] Given the `[d]ispatch` footer hint, when the selected task's status is not
      `ready-to-implement` or `agent-crashed`, then the hint is rendered in dim
- [ ] Given the task list is focused, when Tab is pressed, then `focusedPane` changes to
      `detailPane` and the footer hints update accordingly
- [ ] Given the task list is focused and the selected task has status `agent-reviewing`, when `o` is
      pressed, then the first PR URL is opened (or issue URL if `prs` is empty)
- [ ] Given the detail pane is focused and a task is pinned, when `o` is pressed, then the URL is
      resolved from the pinned task (not the selected task)
- [ ] Given `selectedIssue` is `null` (empty list), when `Enter` is pressed, then nothing happens
- [ ] Given both sections have zero tasks, when navigation keys are pressed, then nothing happens
      and `selectedIssue` remains `null`

### Startup and Shutdown

- [ ] Given the TUI starts, when engine event subscriptions are registered, then they are registered
      before `engine.start()` is called
- [ ] Given the user confirms quit with running agents, when `shutdown` is sent to the engine, then
      the overlay displays a countdown that updates as agents complete

## Known Limitations

- PRs with no closing keyword in the body (no linked issue) are not tracked by the TUI. They do not
  appear in any task's `prs` array.
- `agentCount` is session-local. It resets to 0 on restart because the control plane uses ephemeral
  state.
- Items beyond section sub-pane capacity are not reachable via keyboard navigation. The `(V/N)`
  overflow indicator signals truncation, but the user cannot scroll to hidden items.

## Dependencies

### Engine Spec Changes Required

This spec depends on changes to the engine event interface (see
[Control Plane Engine](./control-plane-engine.md)):

1. **Simplified event set.** The engine emits 7 event types: `issueStatusChanged` (with
   `newStatus: null` for removal), `ciStatusChanged`, `prLinked`, `agentStarted`, `agentCompleted`,
   `agentFailed`, `specChanged`. All convenience/semantic events (`issueBlocked`, `prApproved`,
   `dispatchReady`, etc.) are removed.
2. **New `prLinked` event.** Emitted when the PRPoller detects a PR linked to a tracked issue via
   closing-keyword matching on the PR body. Carries `issueNumber`, `prNumber`, `url`, `ciStatus`.
3. **`sessionID` on all agent events.** `agentCompleted` must include `sessionID` (currently only on
   `agentStarted` and `agentFailed`).
4. **`branchName` and `logFilePath` on `agentStarted`.** These are known at dispatch time and should
   be included in the start event rather than only on completion/failure.
5. **`issueRemoved` folded into `issueStatusChanged`.** Removal is signaled by `newStatus: null`.
6. **Removed event fields.** `resolutionGuidance`, `clipboardCommand`, and `contextURL` are removed
   from all event payloads.
7. **`getAgentStream` keyed by `sessionID`.** The stream accessor accepts `sessionID` instead of
   `issueNumber`.
8. **PRPoller closing-keyword parsing.** The PRPoller must parse PR bodies for closing keywords
   (`closes #N`, `fixes #N`, etc.) to establish issue-PR linkage and emit `prLinked` events.

### Existing Dependencies

- [Control Plane Engine](./control-plane-engine.md) — event emitter, command interface, query
  interface, stream accessor.
- [Control Plane](./control-plane.md) — parent spec defining architecture and dispatch tiers.
- Ink — React for the terminal.
- Zustand — state management.

## References

- [Control Plane Engine](./control-plane-engine.md) — engine spec (v0.17.0).
- [Control Plane](./control-plane.md) — parent spec.
