---
title: Control Plane TUI — Failure Overlay
version: 0.2.0
last_updated: 2026-02-09
status: approved
---

# Control Plane TUI — Failure Overlay

## Overview

When an agent session fails, the engine's crash recovery resets the issue's GitHub status to `pending`. Without a TUI-side overlay, the failure would be invisible — the issue would appear as a normal pending issue, and the user would not know it had failed or have the option to retry. The failure overlay preserves the error state in the TUI's Zustand store (`lastFailure` on `TrackedIssue`) so the user can see the failure, inspect error details, and retry — even after the engine has already recovered the GitHub state.

This spec defines the failure overlay's behavior: how failures are recorded, how they interact with recovery events, how they render in the issue list and detail pane, and how the user retries.

## Constraints

- The failure overlay is a TUI-only concept. The engine has no knowledge of it — it operates on GitHub status labels.
- The overlay must not prevent the user from seeing normal issue state. Clearing `lastFailure` (via retry or non-recovery poll) restores the standard view.
- Planner failures do not use the failure overlay. The Planner operates on specs, not task issues, so there is no issue to overlay. Planner failures are surfaced only via notifications.

## Specification

### Failure Recording

When the engine emits `agentFailed` for an Implementor or Reviewer, the store records `lastFailure` on the affected issue's `TrackedIssue` entry by mapping fields directly from the `AgentFailedEvent`:

```ts
lastFailure?: {
  agentType: 'implementor' | 'reviewer'; // from event.agentType (narrowed — Planner excluded)
  error: string;                          // from event.error
  sessionID: string;                      // from event.sessionID
  worktreePath?: string;                  // from event.worktreePath (present for Implementor failures)
  logFilePath?: string;                   // from event.logFilePath (present when engine logging.agentSessions is enabled)
};
```

This field is defined on `TrackedIssue` in `control-plane-tui.md` § Type Definitions.

For Planner `agentFailed` events, the store sets `plannerRunning: false` and adds a notification, but does **not** record `lastFailure` on any issue.

### Failure Clearing

`lastFailure` is cleared in exactly two scenarios:

1. **User-initiated retry.** The user presses Enter on a failed issue, confirms the retry prompt, and the store calls `dispatchImplementor` or `dispatchReviewer` (matching `lastFailure.agentType`). The dispatch action clears `lastFailure` before sending the command to the engine.

2. **Non-recovery status change.** When `issueStatusChanged` fires for the issue and `isRecovery` is **not** true, `lastFailure` is cleared. This covers the case where the issue's status changes via a normal IssuePoller cycle (e.g., a human manually changes the label on GitHub).

`lastFailure` is **not** cleared when:

- The `issueStatusChanged` event has `isRecovery: true`. Recovery events are synthetic — they represent the engine resetting a stale status to `pending`, not a real external change. Clearing the overlay on recovery would hide the failure before the user has a chance to see it.

### Issue List Rendering

When an issue has `lastFailure` set, the issue list renders it with an **error indicator** regardless of the issue's GitHub status label (`statusLabel`). The error indicator takes precedence over all status-based indicators (see state indicator table in `control-plane-tui.md` § Issue List Pane).

The issue remains in its normal sort position — failure does not change sort order. Active agents are still pinned above failed issues.

### Detail Pane Rendering

When a failed issue is selected, the detail pane displays the failure overlay instead of the normal status-based content. The overlay shows:

- **Error message** — from `lastFailure.error`, styled red.
- **Session ID** — from `lastFailure.sessionID`. Displayed so the user can manually resume the session outside the control plane if desired.
- **Worktree path** — from `lastFailure.worktreePath`, present only for Implementor failures. The Implementor's worktree is preserved on failure so work-in-progress is not lost.
- **Log file path** — from `lastFailure.logFilePath`, present only when engine logging is enabled. Rendered as an OSC 8 terminal hyperlink to `file://{logFilePath}`.
- **Retry prompt** — instructs the user to press Enter to retry.

The failure overlay takes precedence over all other detail pane content for the affected issue. When `lastFailure` is cleared, the detail pane reverts to the normal content for the issue's current status.

### Retry Flow

When the user presses Enter on a failed issue:

1. A confirmation prompt is shown: `Retry {agentType} for #N? [y/n]` (agent type from `lastFailure.agentType`, capitalized — e.g., "Retry Implementor for #39?").
2. On `y`: Clear `lastFailure` on the issue. Dispatch the appropriate agent — `dispatchImplementor` for Implementor failures, `dispatchReviewer` for Reviewer failures.
3. On `n` or `Escape`: Dismiss the prompt. `lastFailure` remains set.

The confirmation prompt follows the same rendering and exclusivity rules as all other prompts (see `control-plane-tui.md` § Keyboard Controls).

## Acceptance Criteria

### Failure Recording

- [ ] Given the engine emits `agentFailed` for an Implementor on issue N, when the store processes it, then `lastFailure` is set on the issue with error details, session ID, worktree path, and log file path (if present).
- [ ] Given the engine emits `agentFailed` for a Reviewer on issue N, when the store processes it, then `lastFailure` is set on the issue with error details, session ID, and log file path (if present). No worktree path is recorded.
- [ ] Given the engine emits `agentFailed` for the Planner, when the store processes it, then no `lastFailure` is set on any issue.

### Failure Clearing

- [ ] Given an issue has `lastFailure` set, when the user presses Enter and confirms (retry), then `lastFailure` is cleared and the appropriate agent is dispatched (matching `lastFailure.agentType`).
- [ ] Given an issue has `lastFailure` set, when the issue's status changes on a subsequent non-recovery poll (`isRecovery` is false or absent), then `lastFailure` is cleared.
- [ ] Given an issue has `lastFailure` set, when a recovery event fires for the issue (`isRecovery` is true), then `lastFailure` is **not** cleared.

### Issue List Rendering

- [ ] Given an issue has `lastFailure` set, when the issue list renders, then the issue shows an error indicator regardless of its GitHub status label.

### Detail Pane Rendering

- [ ] Given a failed issue is selected, when the detail pane renders, then it shows error details, session ID, and the preserved worktree path (Implementor only).
- [ ] Given an issue has `lastFailure` with a `logFilePath`, when the failure overlay renders in the detail pane, then the log file path is displayed as an OSC 8 terminal hyperlink to `file://{logFilePath}`.
- [ ] Given an issue has `lastFailure` without a `logFilePath`, when the failure overlay renders in the detail pane, then the log file path line is omitted entirely.

### Retry Flow

- [ ] Given a failed issue is selected, when the user presses Enter, then a retry confirmation prompt is shown with the agent type and issue number.
- [ ] Given the retry confirmation prompt is shown, when the user presses `n` or `Escape`, then the prompt is dismissed and `lastFailure` remains set.
- [ ] Given an issue has `lastFailure` set with `agentType: 'implementor'`, when crash recovery resets the issue to `pending`, then the failure overlay displays the correct agent type from `lastFailure.agentType` (not from `TrackedIssue.agentType`).

## Dependencies

- `control-plane-tui.md` — Parent TUI spec (store, type definitions, event handler table, pane rendering)
- `control-plane-engine.md` — Engine events (`agentFailed`, `issueStatusChanged` with `isRecovery`)
- `control-plane-engine-recovery.md` — Crash recovery behavior (resets GitHub status to `pending` after agent failure)

## References

- `control-plane-engine-recovery.md` — Crash recovery (resets GitHub status to `pending` after agent failure, `isRecovery` flag on synthetic events)
- `control-plane-tui.md` § State Management — Event handler table, `TrackedIssue` type definition
