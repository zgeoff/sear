---
title: Control Plane Engine — Agent Session Logging
version: 0.1.0
last_updated: 2026-02-12
status: approved
---

# Control Plane Engine — Agent Session Logging

## Overview

When enabled, the Agent Manager writes a human-readable transcript of each agent session to disk.
Logs capture the full SDK message stream — session metadata, assistant text, tool invocations,
result summaries, and unrecognized message types. This provides a durable record of agent activity
for debugging and auditing.

## Constraints

- Log writing failures are non-fatal — agent session behavior is unaffected.

## Specification

### File Lifecycle

1. When a session starts (SDK `init` message received), create the log file at
   `{logsDir}/{timestamp}-{agentType}[-{context}].log` where:
   - `timestamp` is `Date.now()` (milliseconds since epoch)
   - `agentType` is `planner`, `implementor`, or `reviewer`
   - `[-{context}]` is `-{issueNumber}` for Implementor/Reviewer, omitted entirely (including the
     dash) for Planner
   - Examples: `1738934400000-implementor-42.log`, `1738934400000-planner.log`
2. Write the session header immediately.
3. As each SDK message arrives, format and append it to the file.
4. When the session ends (success, failure, or cancellation), write a footer with the outcome, then
   close the file. The footer must be written before the terminal event (`agentCompleted` /
   `agentFailed`) is emitted, so that `logFilePath` points to a complete file. The `Outcome` line
   uses one of three values: `completed` (SDK reports success), `failed` (SDK reports error or
   session throws), or `cancelled` (user cancellation, shutdown, or timeout). Cancellation flows
   through `agentFailed` at the event level, but the log footer preserves the distinction.

### Log File Format

```
=== Agent Session ===
Type:       planner
Session ID: abc-123
Spec Paths: docs/specs/workflow/control-plane-tui.md
Started:    2026-02-08T19:21:39.000Z

=== Messages ===

[19:21:39] SYSTEM init
  Model: claude-opus-4-6
  CWD: /home/geoff/projects/sear
  Tools: Read, Write, Edit, Bash, Glob, Grep

[19:21:40] ASSISTANT
  Let me read the spec file to understand the changes.

[19:21:40] ASSISTANT
  [tool_use] Read

[19:21:42] ASSISTANT
  I've read the spec. Let me create the task issues...

[19:21:50] RESULT success
  Duration: 11.0s
  Cost:     $0.15
  Turns:    5
  Tokens:   5000 in / 2000 out

=== Session End ===
Outcome:  completed
Finished: 2026-02-08T19:21:50.000Z
```

### Context-Specific Header Fields

| Agent       | Header field                          |
| ----------- | ------------------------------------- |
| Planner     | `Spec Paths: {comma-separated paths}` |
| Implementor | `Issue: #{issueNumber}`               |
| Reviewer    | `Issue: #{issueNumber}`               |

### Message Formatting

All `[HH:MM:SS]` timestamps are UTC. Each SDK `assistant` message may contain multiple content
blocks (text and tool_use mixed). The Agent Manager writes one `[HH:MM:SS] ASSISTANT` line per
content block, not per SDK message.

| SDK Message Type             | Format                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system` + `init`            | `[HH:MM:SS] SYSTEM init` followed by model, CWD, available tools                                                                                                                                                    |
| `assistant` (text block)     | `[HH:MM:SS] ASSISTANT` followed by text content, indented (2 spaces)                                                                                                                                                |
| `assistant` (tool_use block) | `[HH:MM:SS] ASSISTANT` followed by `[tool_use] {toolName}` (name only, no input/output)                                                                                                                             |
| `result`                     | `[HH:MM:SS] RESULT {subtype}` followed by available session metadata (duration, cost, turns, token counts — logged if present in the SDK result message)                                                            |
| All other types              | `[HH:MM:SS] UNKNOWN {type}` followed by raw JSON of the message. This intentionally includes SDK message types like `user` and `tool_result` — they receive the generic treatment rather than dedicated formatting. |

### Error Handling

Log writing failures are non-fatal. If the `logsDir` directory cannot be created or the log file
cannot be opened, the Agent Manager skips logging for the remainder of that session — no
`logFilePath` is included in the terminal event. If a write fails mid-session (e.g., disk full), the
Agent Manager disables logging for the remainder of that session and logs a warning via the
structured logger. The `logFilePath` field is still included in the terminal event, pointing to the
partial file — a partial transcript is more useful than no transcript. In all cases, agent session
behavior is unaffected.

### Log File Path in Events

When agent session logging is enabled, `AgentCompletedEvent` and `AgentFailedEvent` include a
`logFilePath` field with the absolute path to the session log file. The field is absent when:
logging is disabled, the log file could not be created, or the session ended before the SDK `init`
message was received (no file was opened).

## Acceptance Criteria

- [ ] Given `logging.agentSessions` is `true`, when an agent session receives the SDK init message,
      then a log file is created at `{logsDir}/{timestamp}-{agentType}[-{context}].log` with a
      session header containing agent type, session ID, and context-specific fields (Spec Paths for
      Planner, Issue number for Implementor/Reviewer).
- [ ] Given `logging.agentSessions` is `true`, when SDK messages arrive during the session, then
      each message is formatted and appended to the log file as it arrives (stream-write, not
      buffered).
- [ ] Given `logging.agentSessions` is `true`, when an assistant message contains text blocks, then
      the text is written indented after `[HH:MM:SS] ASSISTANT`. When it contains tool_use blocks,
      then only the tool name is written (no input/output).
- [ ] Given `logging.agentSessions` is `true`, when an SDK message of a type without dedicated
      formatting is received (including `user` and `tool_result`), then it is written as
      `[HH:MM:SS] UNKNOWN {type}` followed by the raw JSON of the message.
- [ ] Given `logging.agentSessions` is `true`, when an agent session completes or fails, then a
      footer with the outcome is appended before the terminal event is emitted, and the
      `agentCompleted`/`agentFailed` event includes `logFilePath`.
- [ ] Given `logging.agentSessions` is `false` (default), when an agent session runs, then no log
      file is created and agent events do not include `logFilePath`.
- [ ] Given `logging.agentSessions` is `true` and the `logsDir` directory does not exist, when a
      session starts, then the directory is created automatically.
- [ ] Given `logging.agentSessions` is `true`, when the log file cannot be created, then the Agent
      Manager skips logging for the remainder of that session and the agent session continues
      unaffected.
- [ ] Given `logging.agentSessions` is `true`, when a write fails mid-session, then the Agent
      Manager disables logging for the remainder of that session, logs a warning, and `logFilePath`
      in the terminal event still points to the partial file.
- [ ] Given `logging.agentSessions` is `true` and two agents run concurrently, when both sessions
      produce output, then each session writes to its own independent log file.

## Dependencies

- [control-plane-engine-agent-manager.md](./control-plane-engine-agent-manager.md) — Parent agent
  manager spec (agent lifecycle, session tracking)
- [control-plane-engine.md](./control-plane-engine.md) — Parent engine spec (event types including
  `logFilePath` on `AgentCompletedEvent` and `AgentFailedEvent`, logging configuration)

## References

- [control-plane-engine.md: Configuration — Logging](./control-plane-engine.md#logging) —
  `agentSessions` and `logsDir` settings
- [control-plane-engine-agent-manager.md: Agent Lifecycle](./control-plane-engine-agent-manager.md#agent-lifecycle)
  — Session completion flow that triggers log footer writing
