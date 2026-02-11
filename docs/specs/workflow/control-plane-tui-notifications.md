---
title: Control Plane TUI — Notifications
version: 0.3.0
last_updated: 2026-02-10
status: approved
---

# Control Plane TUI — Notifications

## Overview

The notifications pane is a scrollable, chronological event history that surfaces all engine events as user-readable entries. Newest notifications appear at the top. Each notification includes a colored indicator glyph, timestamp, semantically highlighted content, and optional interactivity (open in browser, copy to clipboard).

## Constraints

- Notifications persist for the entire session as scrollable history — they are never removed.
- The notification history is append-only. `notificationDismissed` events add a new dismissal entry; they do not remove previous entries.
- Notification `contextURL` may be updated in-place for `agentCompleted` (Implementor) and `notification` (`approved`) after async PR URL lookup. This is the only exception to append-only.

## Specification

### Pane Behavior

The notifications pane uses the shared list primitives (see [control-plane-tui.md: Shared List Primitives](./control-plane-tui.md#shared-list-primitives)) for header, alternating rows, selection highlighting, single-line truncation, and scroll windowing.

**Item format:** Each notification renders as a single line:

```
{indicator} [HH:MM] {content}{copy-indicator}
```

- **Indicator** — A colored glyph identifying the event type (see indicator table).
- **Timestamp** — Local wall-clock time in `[HH:MM]` format.
- **Content** — Notification text with semantic highlighting (see rendering rules).
- **Copy indicator** — ` [copy]` suffix, present only when the notification has a `clipboardCommand`.

### Auto-Scroll Behavior

When a new notification is prepended to the list, the pane's scroll behavior depends on how far the user has scrolled from the top:

- **Within one page of the top** (scroll offset < visible item count): The viewport resets to offset 0. The newest notification is always visible.
- **Past one page** (scroll offset ≥ visible item count): The viewport offset increments by 1 to hold the current logical position — the same items stay in view. The user is reading history and is not interrupted.

This ensures the most recent notification is always visible by default, while preserving the user's scroll position when they have intentionally scrolled into history.

### Notification Indicators

| Event Type | Glyph | Color |
|-----------|-------|-------|
| `dispatchReady` | `●` | Green |
| `agentStarted` | `▶` | Blue |
| `agentCompleted` | `✓` | Green |
| `agentFailed` | `✗` | Red |
| `agentSkipped` | `–` | Yellow |
| `issueStatusChanged` | `→` | Cyan |
| `specChanged` | `~` | Magenta |
| `recoveryPerformed` | `↻` | Yellow |
| `notification` (`approved`) | `★` | Green |
| `notification` (`needs-refinement`, `blocked`) | `★` | Yellow |
| `notificationDismissed` | `×` | Dim |
| `issueRemoved` | `−` | Dim |
| `startup` | `✓` | Green |

### Notification Text

| Engine Event | Notification Content |
|-------------|---------------------|
| `agentStarted` | `{AgentType} started for #{N}` (task agents) — `Planner started for {N} specs` (Planner) |
| `agentCompleted` | `{AgentType} completed for #{N}` (task agents) — `Planner completed for {N} specs` (Planner). When `logFilePath` is present, append ` (logs)` suffix. |
| `agentFailed` | `{AgentType} failed for #{N} — {error}` (task agents) — `Planner failed — {error}` (Planner). When `logFilePath` is present, append ` (logs)` suffix. Note: session ID is available on the `AgentFailedNotification` type for programmatic access but is not rendered in the notification text. |
| `issueStatusChanged` | `#{N}: {oldStatus} → {newStatus}` (e.g., `#39: none → pending`). When `oldStatus` is `null` (first detection), render as `none`. |
| `specChanged` | `Spec changed: {fileName}` (filename only, directories stripped). `contextURL` links to the commit diff. |
| `recoveryPerformed` | `#{N} recovered from stale` |
| `notification` (`needs-refinement`) | `#{N} needs refinement — {resolutionGuidance}` |
| `notification` (`blocked`) | `#{N} blocked — {resolutionGuidance}` |
| `notification` (`approved`) | `#{N} approved — ready to merge` |
| `agentSkipped` | `{AgentType} skipped for #{N}` (task agents — agent already running for this issue) — `Planner skipped — paths deferred` (Planner) |
| `dispatchReady` | `#{N} ready for dispatch` |
| `notificationDismissed` | `#{N} dismissed` |
| `issueRemoved` | `#{N} removed` |
| `startup` | `Startup complete: {issueCount} issues tracked, {recoveriesPerformed} recoveries performed` (recoveries clause omitted if zero) |

### Semantic Highlighting

Notification content is composed of color-coded, optionally-linked segments. The `summary` field retains a plain-text version for logging and accessibility.

| Entity | Style | Hyperlink |
|--------|-------|-----------|
| Agent names (`Implementor`, `Reviewer`, `Planner`) | Bold cyan | — |
| Issue references (`#{N}`) | Bold | Issue URL (`https://github.com/{owner}/{repo}/issues/{N}`) |
| Status labels (`pending`, `in-progress`, etc.) | Status color (see table below) | — |
| Spec filenames | Magenta | Commit diff URL (from `contextURL`) |
| Error messages | Red | — |
| Log file links (`(logs)`) | Dim | `file://{logFilePath}` (OSC 8 terminal hyperlink — clickable in supported terminals, plain text in others) |
| All other text | Default | — |

**Status label colors:**

| Status | Color |
|--------|-------|
| `pending`, `unblocked`, `needs-changes` | Default |
| `in-progress` | Blue |
| `review` | Cyan |
| `needs-refinement`, `blocked` | Yellow |
| `approved` | Green |
| `none` (first detection) | Dim |

### Interaction

When the notifications pane is focused, arrow keys scroll through entries. Enter opens the notification's `contextURL` in the user's default browser. If the notification has no `contextURL`, Enter is a no-op.

### Context URL Assignment

The store sets `contextURL` when creating each notification:

- **Issue-related notifications** — `contextURL` is the issue URL. This applies to all notifications with an `issueNumber`.
- **`agentCompleted` (Implementor)** and **`notification` (`approved`)** — `contextURL` is set to the issue URL initially, then updated asynchronously to the PR URL via `getPRForIssue` (in-place update; no-op if the notification no longer exists). If `getPRForIssue` returns `null` (no linked PR found), `contextURL` remains unchanged (falls back to the issue URL).
- **`specChanged`** — `contextURL` is the commit diff URL: `https://github.com/{owner}/{repo}/commit/{commitSHA}` (where `commitSHA` is from the `SpecChangedEvent`). Note: the commit SHA is the HEAD at poll time, not per-file — if multiple commits were pushed between polls, the diff URL shows the HEAD commit's full diff (see [control-plane-engine-pollers.md: SpecPoller](./control-plane-engine-pollers.md#specpoller) for details).
- **Planner notifications** (no `issueNumber`) — No `contextURL`. Enter is a no-op.
- **`startup`** — No `contextURL`. Enter is a no-op.

### Type Definitions

```ts
// Discriminated union for notifications. Each variant carries typed fields
// for its event, enabling per-type rendering and type guards. The summary
// field is a plain-text fallback for logging and accessibility; the
// component builds rich rendering from the typed fields.
//
// Derived values (contextURL, summary text) are computed at notification
// creation time from the source engine event. Source event data not needed
// for rendering (e.g., commitSHA for SpecChangedNotification, oldStatus/
// newStatus for RecoveryPerformedNotification) is intentionally not retained
// — the notification carries only the fields needed for display and
// interaction. clipboardCommand is preserved on BaseNotification for the
// copy-to-clipboard interaction (populated only for needs-refinement events).
type BaseNotification = {
  id: string; // unique, generated by store
  timestamp: string; // ISO 8601
  summary: string; // plain-text rendering for logging/accessibility
  contextURL?: string; // URL opened by Enter (issue, PR, or commit)
  clipboardCommand?: string; // CLI command copied by 'c' keybinding — only populated for notification-type events (needs-refinement); undefined for all other event types
};

type AgentStartedNotification = BaseNotification & {
  eventType: 'agentStarted';
  agentType: 'implementor' | 'reviewer' | 'planner';
  issueNumber?: number; // present for task agents, absent for Planner
  specCount?: number; // always present when agentType is 'planner' (number of specs in batch)
};

type AgentCompletedNotification = BaseNotification & {
  eventType: 'agentCompleted';
  agentType: 'implementor' | 'reviewer' | 'planner';
  issueNumber?: number;
  specCount?: number; // present when agentType is 'planner' (derived from event.specPaths.length at creation time)
  logFilePath?: string; // present when engine logging.agentSessions is enabled
};

type AgentFailedNotification = BaseNotification & {
  eventType: 'agentFailed';
  agentType: 'implementor' | 'reviewer' | 'planner';
  issueNumber?: number;
  error: string;
  sessionID: string;
  logFilePath?: string; // present when engine logging.agentSessions is enabled
};

type AgentSkippedNotification = BaseNotification & {
  eventType: 'agentSkipped';
  agentType: 'implementor' | 'reviewer' | 'planner';
  issueNumber?: number;
};

type IssueStatusChangedNotification = BaseNotification & {
  eventType: 'issueStatusChanged';
  issueNumber: number;
  oldStatus: string | null; // null on first detection
  newStatus: string;
};

type SpecChangedNotification = BaseNotification & {
  eventType: 'specChanged';
  specFileName: string; // filename only, no directory path
};

type RecoveryPerformedNotification = BaseNotification & {
  eventType: 'recoveryPerformed';
  issueNumber: number;
};

type DispatchReadyNotification = BaseNotification & {
  eventType: 'dispatchReady';
  issueNumber: number;
};

type EngineEventNotification = BaseNotification & {
  eventType: 'notification';
  issueNumber: number;
  notificationType: 'needs-refinement' | 'blocked' | 'approved';
  resolutionGuidance?: string; // always present when notificationType is 'needs-refinement' or 'blocked' (engine guarantee)
  // clipboardCommand is inherited from BaseNotification — map from the engine's
  // NotificationEvent.clipboardCommand at creation time (present for needs-refinement only).
};

type NotificationDismissedNotification = BaseNotification & {
  eventType: 'notificationDismissed';
  issueNumber: number;
};

type IssueRemovedNotification = BaseNotification & {
  eventType: 'issueRemoved';
  issueNumber: number;
};

type StartupNotification = BaseNotification & {
  eventType: 'startup';
  issueCount: number;
  recoveriesPerformed: number;
};

type Notification =
  | AgentStartedNotification
  | AgentCompletedNotification
  | AgentFailedNotification
  | AgentSkippedNotification
  | IssueStatusChangedNotification
  | SpecChangedNotification
  | RecoveryPerformedNotification
  | DispatchReadyNotification
  | EngineEventNotification
  | NotificationDismissedNotification
  | IssueRemovedNotification
  | StartupNotification;
```

## Acceptance Criteria

- [ ] Given an engine event occurs, when the notification is added, then it appears at the top of the notifications pane with a colored indicator glyph, timestamp in `[HH:MM]` format, and semantically highlighted content.
- [ ] Given notifications exist, when the user scrolls the notifications pane, then all session notifications are accessible (scrollable history).
- [ ] Given an issue-related notification is selected, when the user presses Enter, then the issue is opened in the user's browser.
- [ ] Given a notification with a clipboard command is selected, when the user presses `c`, then the command is copied to the system clipboard.
- [ ] Given a notification without a clipboard command is selected, when the user presses `c`, then nothing happens (no-op).
- [ ] Given a notification contains an issue reference (`#{N}`), when it renders, then the issue number is bold and rendered as a terminal hyperlink to the issue URL.
- [ ] Given a notification contains an agent name, when it renders, then the agent name (`Implementor`, `Reviewer`, `Planner`) is displayed in bold cyan.
- [ ] Given a notification contains status labels, when it renders, then each status label is colored according to the status label color table.
- [ ] Given a notification for `specChanged`, when it renders, then only the filename is shown (directories stripped) and it is a terminal hyperlink to the commit diff.
- [ ] Given an `issueStatusChanged` notification, when it renders, then the format is `#{N}: {oldStatus} → {newStatus}`.
- [ ] Given a notification with a `contextURL`, when the user presses Enter, then the URL is opened in the browser.
- [ ] Given a Planner notification with no `contextURL`, when the user presses Enter, then nothing happens (no-op).
- [ ] Given an `agentCompleted` or `agentFailed` notification with a `logFilePath`, when it renders, then the notification text includes a ` (logs)` suffix styled dim and rendered as an OSC 8 terminal hyperlink to `file://{logFilePath}`.
- [ ] Given an `agentCompleted` or `agentFailed` notification without a `logFilePath`, when it renders, then no ` (logs)` suffix is shown.
- [ ] Given an `issueRemoved` notification, when it renders, then the indicator is `−` in dim color and the content is `#{N} removed`.
- [ ] Given a `recoveryPerformed` notification, when it renders, then the indicator is `↻` in yellow and the content is `#{N} recovered from stale`.
- [ ] Given a `startup` notification, when it renders, then the indicator is `✓` in green and the content includes the issue count and recoveries performed (recoveries clause omitted if zero).
- [ ] Given a `notification` (`needs-refinement`) event, when the notification renders, then the content includes the resolution guidance text.
- [ ] Given a `notification` (`blocked`) event, when the notification renders, then the content includes the resolution guidance text.
- [ ] Given the notifications pane viewport is at the top (scroll offset 0), when a new notification arrives, then the viewport remains at offset 0 and the new notification is visible.
- [ ] Given the notifications pane viewport is within one page of the top (scroll offset < visible item count), when a new notification arrives, then the viewport resets to offset 0.
- [ ] Given the notifications pane viewport is past one page (scroll offset ≥ visible item count), when a new notification arrives, then the viewport offset increments by 1 and the same items remain visible.

## Dependencies

- `control-plane-tui.md` — Parent TUI spec (shared list primitives, store, event handler table, keyboard controls)
- `control-plane-engine.md` — Engine events consumed by the notifications pane

## References

- [control-plane-tui.md: Shared List Primitives](./control-plane-tui.md#shared-list-primitives) — Pane rendering foundation
- [control-plane-tui.md: Keyboard Controls](./control-plane-tui.md#keyboard-controls) — Notifications pane key bindings
- [control-plane-tui.md: Opening External Resources](./control-plane-tui.md#opening-external-resources) — URL patterns
