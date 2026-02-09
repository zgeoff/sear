---
title: Control Plane Engine — Agent Manager
version: 0.2.0
last_updated: 2026-02-09
status: approved
---

# Control Plane Engine — Agent Manager

## Overview

The Agent Manager handles agent session lifecycle — creating sessions via the Claude Agent SDK, tracking active sessions, monitoring completion, managing worktrees for Implementors, exposing live agent output streams, and handling session logging. It owns all direct interaction with `@anthropic-ai/claude-agent-sdk` and `gray-matter`, keeping SDK specifics isolated from the rest of the engine.

## Constraints

- No file outside `engine/agent-manager/` may import from `@anthropic-ai/claude-agent-sdk` or `gray-matter`.
- Must not dispatch more than one agent per task issue at a time.
- Must preserve Implementor worktrees on failure for inspection.
- Must remove Implementor worktrees on success.
- Log writing failures are non-fatal — agent session behavior is unaffected.

## Specification

### Agent Lifecycle

When the engine dispatches an agent:

1. **Guard** — Check if an agent is already running for this issue. If so, emit `agentSkipped` and return.
2. **Worktree** (Implementor only) — Create or reuse a worktree at `.worktrees/issue-<N>` on branch `issue-<N>`. See `control-plane.md` § Worktree Isolation.
3. **Create session** — Create an agent session via `query()` from `@anthropic-ai/claude-agent-sdk`. The engine loads the agent definition inline (see Agent Definition Loading) and passes it to the SDK via the `agents` option. See SDK Session Configuration below for the full call signature.
4. **Capture session ID** — The SDK returns a `session_id` in its init message. Store this alongside the session handle.
5. **Track** — Record the agent session as running for this issue/spec, including the session handle, session ID, and worktree path (if Implementor).
6. **Emit** — Emit `agentStarted` with the session ID.
7. **Start duration timer** — Begin a timer for `maxAgentDuration` seconds. If the timer fires before the session completes, cancel the session (treated as failure).
8. **Monitor** — Non-blocking. When the session completes:
   - Remove from active tracking.
   - If session succeeded: emit `agentCompleted`. If Implementor, remove the worktree.
   - If session failed: emit `agentFailed` with session ID and worktree path (Implementor only). If Implementor, preserve the worktree for inspection.
   - **Crash recovery (Implementor only):** After emitting `agentFailed`/`agentCompleted`, the Agent Manager reports the completion to the Engine Core. The Engine Core invokes Recovery to check if the issue is still `status:in-progress` and, if so, resets it to `status:pending`, emits `recoveryPerformed` and a synthetic `issueStatusChanged`. See `control-plane-engine-recovery.md`. The Agent Manager does not perform recovery directly — it reports completion and the Engine Core mediates.
   - **Planner sessions** skip crash recovery entirely (no associated issue).
   - **Reviewer sessions** skip crash recovery (issue stays `status:review`; see `control-plane-engine-recovery.md` § Reviewer Failure).

**Session resume:** The SDK supports resuming a failed session via `resume: sessionId`. The engine does not resume sessions automatically — it always starts fresh sessions. However, the session ID from a failed run is included in the `agentFailed` event so the TUI can surface it to the user for manual resume outside the control plane if needed.

Each agent session receives trigger-specific context as its initial prompt:

| Agent | Trigger Context |
|-------|----------------|
| Planner | Changed spec file paths (space-separated) |
| Implementor | Issue number |
| Reviewer | Issue number |

### Agent Definition Loading

The engine reads agent definition files from `.claude/agents/<name>.md` at the repository root and passes them inline to the SDK. This is required because the SDK's `settingSources: ['project']` resolution hangs indefinitely when `cwd` is a git worktree — worktrees use a `.git` file (pointer to the main repository's `.git` directory) instead of a `.git` directory, and the SDK's project settings resolution does not handle this case.

**Loading process:**

1. The `QueryFactory` receives `repoRoot` at construction time.
2. When creating a session, it reads `{repoRoot}/.claude/agents/{agentName}.md` from disk.
3. It parses the file's YAML frontmatter using `gray-matter`, extracting: `description`, `tools` (comma-separated string → `string[]`), `model`, and any other frontmatter fields.
4. The markdown body (after frontmatter) becomes the agent's `prompt` (system prompt).
5. It constructs an `AgentDefinition` object (SDK type) and passes it via the `agents` option in the `query()` call.

**Frontmatter field mapping:**

| Agent file frontmatter | `AgentDefinition` field | Transform |
|------------------------|------------------------|-----------|
| `description` | `description` | Direct string copy |
| `tools` | `tools` | Split comma-separated string, trim whitespace → `string[]`. The agent files use YAML bare string format (`tools: Read, Grep, Glob, Bash`), which `gray-matter` parses as a single string. If the field is already an array (YAML list syntax), use it directly. |
| `model` | `model` | Direct string copy (e.g., `'opus'`). Defaults to `'inherit'` if absent. |
| (markdown body) | `prompt` | Direct string copy |

**Fields not mapped to `AgentDefinition`:** The agent file frontmatter includes fields like `name`, `skills`, `hooks`, and `permissionMode` that are not part of the SDK's `AgentDefinition` type. These are handled as follows:

- **`hooks`** — Passed programmatically via the SDK's `hooks` option (session-level, not agent-level). The engine provides a TypeScript implementation of the bash validator hook. See Programmatic Hooks below.
- **`skills`** — Discovered by `settingSources: ['project']` from `.claude/skills/` in the project tree. No special handling needed.
- **`permissionMode`** — Overridden by the engine's explicit `permissionMode` option regardless.

**Error handling:** If the agent definition file cannot be read (missing, permissions error) or contains malformed YAML (frontmatter parsing failure), the error propagates to the caller — the session is not created. This is treated as an agent session creation failure (log at `error` level, retry next cycle).

**Module location:** The agent definition loading logic lives in `engine/agent-manager/`. The `buildQueryFactory` function accepts `repoRoot` and performs the file reading and frontmatter parsing internally.

### Programmatic Hooks

The engine passes hooks to the SDK programmatically via the `hooks` option in `query()`, rather than relying on hook definitions in agent files or `.claude/settings.json`. This is necessary because agent-file-level hooks are part of agent definition resolution, which the engine bypasses by providing definitions inline (see Agent Definition Loading).

**Bash validator hook:** All workflow agents run with `permissionMode: 'bypassPermissions'`, which removes all interactive guardrails on the Bash tool. The engine registers a `PreToolUse` hook (matcher: `Bash`) that validates every Bash command against a blocklist/allowlist filter before execution. The validation rules (blocklist patterns, allowlist prefixes, command segmentation, evaluation order) are defined in `agent-hook-bash-validator.md`. The engine provides a TypeScript implementation of those rules; the shell script implementation (`agent-hook-bash-validator-script.md`) serves interactive agent use outside the control plane. Both implementations produce identical accept/reject decisions.

**Hook implementation:**

The `QueryFactory` receives a `PreToolUse` hook callback at construction time and includes it in the `hooks` option of every `query()` call. The callback:

1. Extracts the `command` string from the hook input's `tool_input`.
2. Runs the command through the blocklist (same ERE patterns as the shell script, evaluated via RegExp).
3. If no blocklist match, segments the command (quote-aware splitting on `&&`, `||`, `;`, `|`, newlines) and checks each segment's first word against the allowlist.
4. Returns `{ decision: 'approve' }` to allow, or `{ decision: 'block', reason: '<message>' }` to reject. The `reason` string must use the exact error message format defined in `agent-hook-bash-validator.md` § Error Message Format (`Blocked: matches dangerous pattern '<pattern>'` for blocklist, `Blocked: '<command>' is not in the allowed command list` for allowlist).

The hook callback signature follows the SDK's `HookCallback` type:

```ts
type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;
```

**Module location:** The bash validator TypeScript implementation lives in `engine/agent-manager/`. It implements the validation rules from `agent-hook-bash-validator.md` — blocklist patterns, allowlist prefixes, command segmentation, quote-aware parsing, and evaluation order. See that spec for the normative rule definitions.

### SDK Session Configuration

The Agent Manager creates agent sessions using the v1 `query()` function from `@anthropic-ai/claude-agent-sdk`. The engine loads agent definitions inline (see Agent Definition Loading above) and passes them via the `agents` option, while `settingSources: ['project']` loads project-level settings (CLAUDE.md, `.claude/settings.json`, skills, hooks). The engine controls session-level options (working directory, permissions, cancellation) directly.

**Call signature:**

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const q = query({
  prompt: triggerContext,     // e.g., 'docs/specs/workflow/control-plane-tui.md' or '42'
  options: {
    agent: agentName,         // e.g., 'planner', 'implementor', 'reviewer'
    agents: {
      [agentName]: agentDefinition, // inline AgentDefinition loaded from .claude/agents/<name>.md
    },
    cwd: workingDirectory,    // worktree path (Implementor) or repo root (Planner, Reviewer)
    settingSources: ['project'],
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [bashValidatorHook] }],
    },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    abortController,
  },
});
```

**Option details:**

| Option | Value | Purpose |
|--------|-------|---------|
| `prompt` | Trigger context string | The initial user message. Space-separated spec paths (Planner), or issue number as string (Implementor, Reviewer). |
| `agent` | Agent name from config | Selects which agent definition to use from the `agents` map. |
| `agents` | `Record<string, AgentDefinition>` | Inline agent definitions loaded by the engine from `.claude/agents/<name>.md`. The SDK uses this map instead of resolving agent files from the filesystem via `settingSources`. |
| `cwd` | Worktree or repo root | Implementor: `.worktrees/issue-<N>`. Planner, Reviewer: repository root. |
| `settingSources` | `['project']` | Loads project-level settings: `.claude/settings.json`, CLAUDE.md project instructions, and skills from `.claude/skills/`. Does **not** need to resolve agent definition files because `agents` provides them inline. |
| `hooks` | `{ PreToolUse: [{ matcher: 'Bash', hooks: [bashValidatorHook] }] }` | Programmatic hooks. The bash validator hook validates every Bash command against a blocklist/allowlist before execution. See Programmatic Hooks. |
| `permissionMode` | `'bypassPermissions'` | Agents run non-interactively. All tool invocations are auto-approved. |
| `allowDangerouslySkipPermissions` | `true` | Required safety acknowledgment when using `bypassPermissions` (SDK ≥0.2.x). |
| `abortController` | `AbortController` | Cancellation handle. The engine calls `abortController.abort()` for user cancellation, shutdown, and duration timeout. |

**Why inline loading:** The SDK's `settingSources: ['project']` resolution discovers `.claude/agents/` by traversing the filesystem from `cwd` upward looking for a `.git` directory. Git worktrees have a `.git` file (not a directory), causing the resolution to fail silently — the CLI subprocess hangs indefinitely with zero output. By loading agent definitions inline, the engine reads from the repository root (which always has a `.git` directory) and passes the definitions directly to the SDK, bypassing the worktree resolution issue entirely. This applies to all agent types (Implementor, Planner, Reviewer) for consistency, even though only the Implementor currently runs in a worktree.

**SDK `AgentDefinition` type:**

```ts
type AgentDefinition = {
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  prompt: string;
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  mcpServers?: AgentMcpServerSpec[]; // AgentMcpServerSpec is an SDK-provided type from @anthropic-ai/claude-agent-sdk
};
```

**SDK isolation:** No file outside `engine/agent-manager/` may import from `@anthropic-ai/claude-agent-sdk`. The `QueryFactory` dependency injection seam (see below) ensures the SDK is mockable for testing.

**QueryFactory:** The Agent Manager does not call `query()` directly. It receives a `QueryFactory` function as a dependency, enabling test doubles that simulate the SDK's async message stream without spawning real agent processes.

### Stream Accessor

The engine exposes live agent output streams, separate from the event emitter. Streaming output is high-frequency data that should not flow through the discrete event channel.

| Method | Parameters | Returns |
|--------|-----------|---------|
| `getAgentStream` | Issue number | An `AsyncIterable<string>` of plain text output chunks for the running agent session, or `null` if no agent is running for this issue. |

Each chunk is a plain text string extracted from the SDK session's message stream. The engine subscribes to the SDK session internally, extracts text content from assistant messages, and re-yields it as plain strings. Binary data, tool use metadata, and system messages are not surfaced — only human-readable text output.

The TUI subscribes to agent streams directly for rendering in the detail pane. The stream ends when the agent session completes (success, failure, or cancellation). Cancelling an agent session via `cancelAgent` causes the stream's async iterable to complete. The Agent Manager subscribes to the SDK session's output internally and exposes it through this method.

Planner streams are not exposed through this interface. The Planner operates on specs (not task issues), and `getAgentStream` is keyed by issue number. Planner activity is visible only through notification events (`agentStarted`, `agentCompleted`, `agentFailed`). This is intentional — Planner output (issue creation/updates) is observable via the IssuePoller.

### Agent Session Logging

When `logging.agentSessions` is enabled, the Agent Manager writes a human-readable transcript of each agent session to disk. Logs capture the full SDK message stream — session metadata, assistant text, tool invocations, result summaries, and unrecognized message types.

**File lifecycle:**

1. When a session starts (SDK `init` message received), create the log file at `{logsDir}/{timestamp}-{agentType}[-{context}].log` where:
   - `timestamp` is `Date.now()` (milliseconds since epoch)
   - `agentType` is `planner`, `implementor`, or `reviewer`
   - `[-{context}]` is `-{issueNumber}` for Implementor/Reviewer, omitted entirely (including the dash) for Planner
   - Examples: `1738934400000-implementor-42.log`, `1738934400000-planner.log`
2. Write the session header immediately.
3. As each SDK message arrives, format and append it to the file.
4. When the session ends (success, failure, or cancellation), write a footer with the outcome, then close the file. The footer must be written before the terminal event (`agentCompleted` / `agentFailed`) is emitted, so that `logFilePath` points to a complete file. The `Outcome` line uses one of three values: `completed` (SDK reports success), `failed` (SDK reports error or session throws), or `cancelled` (user cancellation, shutdown, or timeout). Cancellation flows through `agentFailed` at the event level, but the log footer preserves the distinction.

**Log file format:**

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

**Context-specific header fields:**

| Agent | Header field |
|-------|-------------|
| Planner | `Spec Paths: {comma-separated paths}` |
| Implementor | `Issue: #{issueNumber}` |
| Reviewer | `Issue: #{issueNumber}` |

**Message formatting by type:**

All `[HH:MM:SS]` timestamps are UTC. Each SDK `assistant` message may contain multiple content blocks (text and tool_use mixed). The Agent Manager writes one `[HH:MM:SS] ASSISTANT` line per content block, not per SDK message.

| SDK Message Type | Format |
|------------------|--------|
| `system` + `init` | `[HH:MM:SS] SYSTEM init` followed by model, CWD, available tools |
| `assistant` (text block) | `[HH:MM:SS] ASSISTANT` followed by text content, indented (2 spaces) |
| `assistant` (tool_use block) | `[HH:MM:SS] ASSISTANT` followed by `[tool_use] {toolName}` (name only, no input/output) |
| `result` | `[HH:MM:SS] RESULT {subtype}` followed by available session metadata (duration, cost, turns, token counts — logged if present in the SDK result message) |
| All other types | `[HH:MM:SS] UNKNOWN {type}` followed by raw JSON of the message. This intentionally includes SDK message types like `user` and `tool_result` — they receive the generic treatment rather than dedicated formatting. |

**Error handling:** Log writing failures are non-fatal. If the `logsDir` directory cannot be created or the log file cannot be opened, the Agent Manager skips logging for the remainder of that session — no `logFilePath` is included in the terminal event. If a write fails mid-session (e.g., disk full), the Agent Manager disables logging for the remainder of that session and logs a warning via the structured logger. The `logFilePath` field is still included in the terminal event, pointing to the partial file — a partial transcript is more useful than no transcript. In all cases, agent session behavior is unaffected.

**Log file path in events:** When agent session logging is enabled, `AgentCompletedEvent` and `AgentFailedEvent` include a `logFilePath` field with the absolute path to the session log file. The field is absent when: logging is disabled, the log file could not be created, or the session ended before the SDK `init` message was received (no file was opened).

### Type Definitions

```ts
type QueryFactoryParams = {
  prompt: string;
  agent: string; // agent name, e.g., 'planner'
  cwd: string;
  abortController: AbortController;
};

// The factory abstracts the SDK's query() call. The default implementation
// reads agent definition files from {repoRoot}/.claude/agents/{agent}.md,
// parses YAML frontmatter with gray-matter, and passes the inline AgentDefinition
// to the SDK via the agents option. It also passes settingSources,
// permissionMode, and allowDangerouslySkipPermissions. Test doubles return
// a mock Query without spawning a real agent process.
//
// buildQueryFactory(config: QueryFactoryConfig): QueryFactory
type QueryFactory = (params: QueryFactoryParams) => Query; // Query is from @anthropic-ai/claude-agent-sdk

type QueryFactoryConfig = {
  repoRoot: string; // absolute path to the git repository root
  bashValidatorHook: HookCallback; // PreToolUse hook for Bash command validation
};

type AgentManagerConfig = {
  repoRoot: string; // absolute path — used for worktree operations and agent definition loading
  maxAgentDuration: number; // seconds — max time an agent session can run before cancellation
  logging: {
    agentSessions: boolean; // enable writing agent session transcripts to disk
    logsDir: string; // absolute path (resolved by the engine from config + repoRoot)
  };
};

// createAgentManager(config: AgentManagerConfig, queryFactory: QueryFactory): AgentManager
// The Agent Manager does not need GitHubClient, owner, or repo directly —
// crash recovery is mediated by the Engine Core (see control-plane-engine-recovery.md).
// The Agent Manager reports completions via callbacks provided by the Engine Core.

// HookCallback is from @anthropic-ai/claude-agent-sdk
// The engine constructs the bash validator hook and passes it to buildQueryFactory.

// getAgentStream returns null if no agent is running for the issue
type AgentStream = AsyncIterable<string> | null;
```

## Acceptance Criteria

### Agent Lifecycle

- [ ] Given the `dispatchImplementor` command is received for issue N, when no agent is running for issue N, then an Implementor session is created with the working directory set to a worktree at `.worktrees/issue-<N>`.
- [ ] Given the `dispatchImplementor` command is received for issue N, when an agent is already running for issue N, then `agentSkipped` is emitted and no new session is created.
- [ ] Given an agent is already running for issue N, when `dispatchReviewer` is received for issue N, then `agentSkipped` is emitted and no new session is created.
- [ ] Given the `dispatchImplementor` command is received for an issue not in the IssuePoller snapshot, when the command is processed, then it is a no-op.
- [ ] Given the `dispatchImplementor` command is received for an issue whose status is not in the accepted set (`pending`, `unblocked`, `needs-changes`, or `in-progress` with no running agent), when the command is processed, then it is a no-op.
- [ ] Given an agent session is created, when the SDK returns a session ID, then the engine stores the session ID and includes it in the `agentStarted` event.
- [ ] Given an Implementor agent session fails, when the `agentFailed` event is emitted, then it includes the session ID and preserved worktree path.
- [ ] Given an Implementor agent session succeeds, when cleanup runs, then the worktree is removed.
- [ ] Given an Implementor agent session fails, when the failure is detected, then the worktree is preserved.
- [ ] Given the engine dispatches any agent, when `query()` is called, then the options include `agent` (agent name from config), `agents` (map containing an inline `AgentDefinition` loaded from `.claude/agents/<name>.md`), `settingSources: ['project']`, `permissionMode: 'bypassPermissions'`, and `allowDangerouslySkipPermissions: true`.
- [ ] Given the engine dispatches any agent, when the `QueryFactory` loads the agent definition file, then it reads `{repoRoot}/.claude/agents/{agentName}.md`, parses YAML frontmatter with `gray-matter`, maps `description`, `tools` (comma-separated → array), `model` (default `'inherit'`), and the markdown body as `prompt` into an `AgentDefinition`.
- [ ] Given the engine dispatches an Implementor for issue N, when `query()` is called, then `cwd` is set to the worktree path (`.worktrees/issue-<N>`). For Planner and Reviewer, `cwd` is the repository root.
- [ ] Given the engine codebase, when inspected, then no file outside `engine/agent-manager/` imports from `@anthropic-ai/claude-agent-sdk` or `gray-matter`.
- [ ] Given the engine dispatches any agent, when `query()` is called, then the `hooks` option includes a `PreToolUse` hook with matcher `Bash` that implements the bash validator logic from `agent-hook-bash-validator.md`.
- [ ] Given the bash validator hook receives a Bash command matching a blocklist pattern, when the hook evaluates the command, then it returns a block decision with the matched pattern in the reason.
- [ ] Given the bash validator hook receives a Bash command with all segments having allowlisted prefixes, when the hook evaluates the command, then it returns an approve decision.
- [ ] Given `getAgentStream` is called for an issue with a running agent, when the agent produces output, then the returned async iterable yields output chunks.
- [ ] Given `getAgentStream` is called for an issue with no running agent, when called, then it returns `null`.

### Agent Session Logging

- [ ] Given `logging.agentSessions` is `true`, when an agent session receives the SDK init message, then a log file is created at `{logsDir}/{timestamp}-{agentType}[-{context}].log` with a session header containing agent type, session ID, and context-specific fields (Spec Paths for Planner, Issue number for Implementor/Reviewer).
- [ ] Given `logging.agentSessions` is `true`, when SDK messages arrive during the session, then each message is formatted and appended to the log file as it arrives (stream-write, not buffered).
- [ ] Given `logging.agentSessions` is `true`, when an assistant message contains text blocks, then the text is written indented after `[HH:MM:SS] ASSISTANT`. When it contains tool_use blocks, then only the tool name is written (no input/output).
- [ ] Given `logging.agentSessions` is `true`, when an SDK message of a type without dedicated formatting is received (including `user` and `tool_result`), then it is written as `[HH:MM:SS] UNKNOWN {type}` followed by the raw JSON of the message.
- [ ] Given `logging.agentSessions` is `true`, when an agent session completes or fails, then a footer with the outcome is appended before the terminal event is emitted, and the `agentCompleted`/`agentFailed` event includes `logFilePath`.
- [ ] Given `logging.agentSessions` is `false` (default), when an agent session runs, then no log file is created and agent events do not include `logFilePath`.
- [ ] Given `logging.agentSessions` is `true` and the `logsDir` directory does not exist, when a session starts, then the directory is created automatically.
- [ ] Given `logging.agentSessions` is `true`, when the log file cannot be created, then the Agent Manager skips logging for the remainder of that session and the agent session continues unaffected.
- [ ] Given `logging.agentSessions` is `true`, when a write fails mid-session, then the Agent Manager disables logging for the remainder of that session, logs a warning, and `logFilePath` in the terminal event still points to the partial file.
- [ ] Given `logging.agentSessions` is `true` and two agents run concurrently, when both sessions produce output, then each session writes to its own independent log file.

## Dependencies

- `control-plane-engine.md` — Parent engine spec (event types, command interface, configuration)
- `control-plane-engine-recovery.md` — Crash recovery behavior after agent failure
- `control-plane.md` — Parent architecture spec (worktree isolation)
- `@anthropic-ai/claude-agent-sdk` (≥0.2.x) — v1 `query()` API for agent invocations
- `gray-matter` — YAML frontmatter parser for agent definition files
- `agent-hook-bash-validator.md` — Normative validation rules for the Bash tool hook

## References

- `control-plane-engine.md` § Dispatch Logic — When agents are dispatched
- `control-plane-engine.md` § Configuration — Agent names, `maxAgentDuration`, logging settings
- `control-plane-engine-recovery.md` — Crash recovery triggered after agent completion
- `agent-hook-bash-validator-script.md` — Shell script implementation of the bash validator (for interactive use outside the control plane)
