---
title: Control Plane Engine — Agent Manager
version: 0.13.1
last_updated: 2026-02-13
status: approved
---

# Control Plane Engine — Agent Manager

## Overview

The Agent Manager handles agent session lifecycle — creating sessions via the Claude Agent SDK,
tracking active sessions, monitoring completion, managing worktrees for Implementors and Reviewers,
exposing live agent output streams, and handling session logging. It owns all direct interaction
with `@anthropic-ai/claude-agent-sdk` and `gray-matter`, keeping SDK specifics isolated from the
rest of the engine.

## Constraints

- No file outside `engine/agent-manager/` may import from `@anthropic-ai/claude-agent-sdk` or
  `gray-matter`.
- Must not dispatch more than one agent per task issue at a time.
- Must remove Implementor and Reviewer worktrees on completion (success or failure). The branch is
  the durable artifact for inspection.
- Log writing failures are non-fatal — agent session behavior is unaffected. See
  [control-plane-engine-agent-session-logging.md](./control-plane-engine-agent-session-logging.md)
  for the normative definition.

## Specification

### Agent Lifecycle

When the engine dispatches an agent:

1. **Guard** — Check if an agent is already running for this issue. If so, log the skip at `info`
   level and return.
2. **Worktree** (Implementor and Reviewer) — Create a worktree using the appropriate strategy. The
   Engine Core provides a `branchName` and optionally `branchBase` to the Agent Manager at dispatch
   time:
   - **Fresh branch** (Implementor, no linked PR — new task or retry): The Engine Core generates
     `issue-<N>-<timestamp>` as `branchName` with `branchBase: 'main'`. The Agent Manager creates
     the worktree via `git worktree add .worktrees/<branchName> -b <branchName> <branchBase>`.
   - **PR branch** (Implementor, linked PR exists — resume from `needs-changes` or `unblocked`): The
     Engine Core provides the PR's `headRefName` as `branchName` with no `branchBase`. The Agent
     Manager creates the worktree via `git worktree add .worktrees/<branchName> <branchName>`.
   - **Review branch** (Reviewer — always has a linked PR): The Engine Core provides the PR's
     `headRefName` as `branchName` with `fetchRemote: true`. The Agent Manager fetches the branch
     from the remote (`git fetch origin <branchName>`) and creates the worktree from the remote
     tracking ref (`git worktree add .worktrees/<branchName> origin/<branchName>`).
     > **Rationale:** This ensures the Reviewer sees the latest pushed state, even if the branch was
     > modified outside the local repository.

   After the worktree is created (all strategies), run `yarn install` in the worktree directory. If
   `yarn install` fails, remove the worktree and treat the failure as a dispatch failure — emit
   `agentFailed` and do not create a session.

   > **Rationale:** Yarn PnP requires the install/link step in each worktree for platform-specific
   > binaries (turbo, esbuild) and module resolution (`.pnp.cjs`) to work. Without it, agents cannot
   > run typechecking, tests, or builds.

   See [control-plane.md: Worktree Isolation](./control-plane.md#worktree-isolation).

3. **Create session** — Create an agent session via `query()` from `@anthropic-ai/claude-agent-sdk`.
   The engine loads the agent definition inline (see Agent Definition Loading) and passes it to the
   SDK via the `agents` option. See SDK Session Configuration below for the full call signature.
4. **Capture session ID** — The SDK returns a `session_id` in its init message. Store this alongside
   the session handle.
5. **Track** — Record the agent session as running for this issue/spec, including the session
   handle, session ID, and branch name (if Implementor or Reviewer).
6. **Emit** — Emit `agentStarted` with the session ID, `branchName` (Implementor and Reviewer —
   known from step 2), and `logFilePath` (when logging is enabled — the path is computed before the
   session starts from the logging module's naming convention).
7. **Start duration timer** — Begin a timer for `maxAgentDuration` seconds. If the timer fires
   before the session completes, cancel the session (treated as failure).
8. **Monitor** — Non-blocking. When the session completes:
   - Remove from active tracking.
   - If Implementor or Reviewer, remove the worktree via `git worktree remove` (success or failure —
     the branch persists for inspection).
   - If session succeeded: emit `agentCompleted`.
   - If session failed: emit `agentFailed` with session ID and branch name (Implementor and
     Reviewer).
   - **Completion-dispatch (Implementor success only):** The Agent Manager reports the completion to
     the Engine Core, which handles PR detection, `status:review` label setting, and Reviewer
     dispatch. See
     [control-plane-engine.md: Completion-dispatch](./control-plane-engine.md#completion-dispatch).
   - **Crash recovery (Implementor only):** The Agent Manager reports the completion to the Engine
     Core, which invokes Recovery. The Agent Manager does not perform recovery directly — it reports
     completion and the Engine Core mediates. See
     [control-plane-engine-recovery.md](./control-plane-engine-recovery.md).
   - **Planner sessions** skip crash recovery and completion-dispatch entirely (no associated
     issue).
   - **Reviewer sessions** skip crash recovery (issue stays `status:review`; see
     [control-plane-engine-recovery.md: Reviewer Failure](./control-plane-engine-recovery.md#reviewer-failure))
     and skip completion-dispatch.

**Session resume:** The SDK supports resuming a failed session via `resume: sessionId`. The engine
does not resume sessions automatically — it always starts fresh sessions. However, the session ID
from a failed run is included in the `agentFailed` event so the TUI can surface it to the user for
manual resume outside the control plane if needed.

### Trigger Context

Each agent session receives trigger-specific context as its initial prompt:

| Agent       | Trigger Context                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Planner     | Enriched prompt containing: full content of each changed spec (with diffs for modified specs), and existing open task issues (number, title, labels, body). See [control-plane-engine-context-precomputation.md: Planner Context Pre-computation](./control-plane-engine-context-precomputation.md#planner-context-pre-computation).                                                                                           |
| Implementor | Enriched prompt containing: task issue details (number, title, body, labels). When a linked PR exists (resume scenarios): additionally includes per-file PR diffs (filename, status, patch) and prior review submissions and inline comments. See [control-plane-engine-context-precomputation.md: Implementor Context Pre-computation](./control-plane-engine-context-precomputation.md#implementor-context-pre-computation). |
| Reviewer    | Enriched prompt containing: task issue details (number, title, body, labels), PR metadata (number, title from `getPRForIssue`), per-file PR diffs (filename, status, patch), and prior review submissions and inline comments. See [control-plane-engine-context-precomputation.md: Reviewer Context Pre-computation](./control-plane-engine-context-precomputation.md#reviewer-context-pre-computation).                      |

### Agent Definition Loading

The engine reads agent definition files from `.claude/agents/<name>.md` at the repository root and
passes them inline to the SDK.

> **Rationale:** This is one part of the workaround for the SDK's worktree resolution bug (see
> [Known Limitations](#known-limitations)) — agent definitions are loaded from the repository root,
> which always has a `.git` directory.

**Loading process:**

1. The `QueryFactory` receives `repoRoot` at construction time.
2. When creating a session, it reads `{repoRoot}/.claude/agents/{agentName}.md` from disk.
3. It parses the file's YAML frontmatter using `gray-matter`, extracting: `description`, `tools`
   (comma-separated string → `string[]`), `disallowedTools` (comma-separated string → `string[]`),
   `model`, `maxTurns`, and any other frontmatter fields.
4. The markdown body (after frontmatter) becomes the agent's `prompt` (system prompt).
5. It constructs an `AgentDefinition` object (SDK type) and passes it via the `agents` option in the
   `query()` call.

**Frontmatter field mapping:**

| Agent file frontmatter | Target                            | Transform                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`          | `AgentDefinition.description`     | Direct string copy                                                                                                                                                                                                                                              |
| `tools`                | `AgentDefinition.tools`           | Split comma-separated string, trim whitespace → `string[]`. The agent files use YAML bare string format (`tools: Read, Grep, Glob, Bash`), which `gray-matter` parses as a single string. If the field is already an array (YAML list syntax), use it directly. |
| `disallowedTools`      | `AgentDefinition.disallowedTools` | Same comma-separated → `string[]` transform as `tools`. Tools in this list are denied even if they appear in `tools` or would be inherited.                                                                                                                     |
| `model`                | `AgentDefinition.model`           | Direct string copy (e.g., `'opus'`). Defaults to `'inherit'` if absent. Overridden by `modelOverride` from `QueryFactoryParams` when present (see Type Definitions).                                                                                            |
| `maxTurns`             | `query()` option                  | Parsed as integer. Passed as a session-level `query()` option, not as part of `AgentDefinition`. Limits the number of agentic turns before the SDK stops the session. If absent, the SDK default applies (no limit).                                            |
| (markdown body)        | `AgentDefinition.prompt`          | Direct string copy                                                                                                                                                                                                                                              |

**Fields not mapped to `AgentDefinition`:** The agent file frontmatter includes fields like `name`,
`hooks`, and `permissionMode` that are not part of the SDK's `AgentDefinition` type. These are
handled as follows:

- **`hooks`** — Passed programmatically via the SDK's `hooks` option (session-level, not
  agent-level). The engine provides a TypeScript implementation of the bash validator hook. See
  Programmatic Hooks below.
- **`permissionMode`** — Overridden by the engine's explicit `permissionMode` option regardless.

**Fields mapped to session options (not `AgentDefinition`):** Some frontmatter fields map to
`query()` session-level options rather than the `AgentDefinition` object:

- **`maxTurns`** — Passed as a session-level `query()` option. See frontmatter field mapping table
  above.

**Error handling:** If the agent definition file cannot be read (missing, permissions error) or
contains malformed YAML (frontmatter parsing failure), the error propagates to the caller — the
session is not created. This is treated as an agent session creation failure (log at `error` level,
retry next cycle).

**Module location:** The agent definition loading logic lives in `engine/agent-manager/`. The
`buildQueryFactory` function accepts `repoRoot` and performs the file reading and frontmatter
parsing internally.

### Programmatic Hooks

The engine passes hooks to the SDK programmatically via the `hooks` option in `query()`, rather than
relying on hook definitions in agent files or `.claude/settings.json`. This is necessary because
agent-file-level hooks are part of agent definition resolution, which the engine bypasses by
providing definitions inline (see Agent Definition Loading).

**Bash validator hook:** All workflow agents run with `permissionMode: 'bypassPermissions'`, which
removes all interactive guardrails on the Bash tool. The engine registers a `PreToolUse` hook
(matcher: `Bash`) that validates every Bash command against a blocklist/allowlist filter before
execution. The validation rules (blocklist patterns, allowlist prefixes, command segmentation,
evaluation order) are defined in `agent-hook-bash-validator.md`. The engine provides a TypeScript
implementation of those rules; the shell script implementation
(`agent-hook-bash-validator-script.md`) serves interactive agent use outside the control plane. Both
implementations produce identical accept/reject decisions.

**Hook implementation:**

The `QueryFactory` receives a `PreToolUse` hook callback at construction time and includes it in the
`hooks` option of every `query()` call. The callback:

1. Extracts the `command` string from the hook input's `tool_input`.
2. Runs the command through the blocklist (same ERE patterns as the shell script, evaluated via
   RegExp).
3. If no blocklist match, segments the command (quote-aware splitting on `&&`, `||`, `;`, `|`,
   newlines) and checks each segment's first word against the allowlist.
4. Returns `{ decision: 'approve' }` to allow, or `{ decision: 'block', reason: '<message>' }` to
   reject. The `reason` string must use the exact error message format defined in
   [agent-hook-bash-validator.md: Error Message Format](./agent-hook-bash-validator.md#error-message-format)
   (`Blocked: matches dangerous pattern '<pattern>'` for blocklist,
   `Blocked: '<command>' is not in the allowed command list` for allowlist).

The hook callback signature follows the SDK's `HookCallback` type:

```ts
type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;
```

**Module location:** The bash validator TypeScript implementation lives in `engine/agent-manager/`.
It implements the validation rules from `agent-hook-bash-validator.md` — blocklist patterns,
allowlist prefixes, command segmentation, quote-aware parsing, and evaluation order. See that spec
for the normative rule definitions.

### SDK Session Configuration

The Agent Manager creates agent sessions using the v1 `query()` function from
`@anthropic-ai/claude-agent-sdk`. The engine loads agent definitions inline (see
[Agent Definition Loading](#agent-definition-loading) above) and passes them via the `agents`
option. Project context files (CLAUDE.md) are loaded manually and appended to the agent's system
prompt (see [Project Context Injection](#project-context-injection) below). The engine controls
session-level options (working directory, permissions, cancellation) directly.

**Call signature:**

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: triggerContext, // enriched prompt (Planner, Implementor, Reviewer)
  options: {
    agent: agentName, // e.g., 'planner', 'implementor', 'reviewer'
    agents: {
      [agentName]: agentDefinition, // inline AgentDefinition loaded from .claude/agents/<name>.md
      // prompt field includes appended project context (CLAUDE.md)
      // model field may be overridden by modelOverride from caller
    },
    maxTurns, // from agent definition frontmatter (e.g., 50)
    cwd: workingDirectory, // worktree path (Implementor, Reviewer) or repo root (Planner)
    settingSources: [],
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [bashValidatorHook] }],
    },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    abortController,
  },
});
```

**Option details:**

| Option                            | Value                                                               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                          | Trigger context string                                              | The initial user message. Enriched prompt with spec content, diffs, and existing issues (Planner — see [context pre-computation: Planner](./control-plane-engine-context-precomputation.md#planner-context-pre-computation)), enriched prompt with issue details and optionally PR diffs and review comments (Implementor — see [context pre-computation: Implementor](./control-plane-engine-context-precomputation.md#implementor-context-pre-computation)), enriched prompt with issue details, PR diffs, and review comments (Reviewer — see [context pre-computation: Reviewer](./control-plane-engine-context-precomputation.md#reviewer-context-pre-computation)). |
| `agent`                           | Agent name from config                                              | Selects which agent definition to use from the `agents` map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `agents`                          | `Record<string, AgentDefinition>`                                   | Inline agent definitions loaded by the engine from `.claude/agents/<name>.md`. The `prompt` field includes project context appended via `contextPaths` (see Project Context Injection). The `model` field may be overridden by `modelOverride` from `QueryFactoryParams`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `maxTurns`                        | Integer from frontmatter                                            | Maximum number of agentic turns before the SDK stops the session. Read from the agent definition's frontmatter `maxTurns` field. If absent in frontmatter, omitted from options (SDK default: no limit).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cwd`                             | Worktree or repo root                                               | Implementor, Reviewer: `.worktrees/<branchName>`. Planner: repository root.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `settingSources`                  | `[]` (empty)                                                        | Intentionally empty. All project-level concerns are handled manually (see [Known Limitations](#known-limitations)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `hooks`                           | `{ PreToolUse: [{ matcher: 'Bash', hooks: [bashValidatorHook] }] }` | Programmatic hooks. The bash validator hook validates every Bash command against a blocklist/allowlist before execution. See Programmatic Hooks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `permissionMode`                  | `'bypassPermissions'`                                               | Agents run non-interactively. All tool invocations are auto-approved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `allowDangerouslySkipPermissions` | `true`                                                              | Required safety acknowledgment when using `bypassPermissions` (SDK ≥0.2.x).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `abortController`                 | `AbortController`                                                   | Cancellation handle. The engine calls `abortController.abort()` for user cancellation, shutdown, and duration timeout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Known SDK limitation:** The engine sets `settingSources: []` and handles each project-level
concern manually: agent definitions are loaded inline (see
[Agent Definition Loading](#agent-definition-loading)), project context files are injected via
`contextPaths` (see [Project Context Injection](#project-context-injection)), hooks are passed
programmatically, and permissions are set explicitly. This applies to all agent types (Implementor,
Planner, Reviewer) for consistency. See [Known Limitations](#known-limitations) for full detail.

> **Rationale:** The SDK's `settingSources: ['project']` resolution traverses the filesystem from
> `cwd` upward looking for a `.git` directory. Git worktrees have a `.git` file (not a directory),
> causing the resolution to hang indefinitely with zero output — the CLI subprocess never starts.
> This affects **all** project settings resolution: agent definitions, CLAUDE.md,
> `.claude/settings.json`, and skills from `.claude/skills/`. The workaround applies to all agent
> types for consistency, even though only the Planner does not run in a worktree.

### Project Context Injection

Because `settingSources` is empty (see Known SDK Limitation above), the engine manually loads
project context files and appends them to each agent's system prompt. The `QueryFactory` receives a
`contextPaths` array at construction time — a list of file paths relative to `repoRoot`. When
creating a session, the factory reads each file (UTF-8 encoding), concatenates their contents
(separated by double newlines), and appends the result to the agent definition's `prompt` field. The
separator between the agent's original prompt and the appended context block is also a double
newline. Files are read fresh on every session creation — there is no caching.

When `contextPaths` is empty, no context is appended and the agent's original prompt is used as-is.

**Default context paths:** The engine passes `['.claude/CLAUDE.md']` as the default `contextPaths`.

> **Rationale:** This ensures all agents receive the project's coding conventions, style rules, and
> architectural guidance — equivalent to what `settingSources: ['project']` would have provided for
> CLAUDE.md.

**Error handling:** If a context file cannot be read (missing or permissions error), the error
propagates to the caller — the session is not created. This matches the behavior of agent definition
loading failures.

> **Rationale:** Per-agent contextual injection is not yet supported — all agents receive the same
> context files. The `contextPaths` mechanism can be extended in the future by accepting per-agent
> context paths at dispatch time.

### Planner Context Pre-computation

When dispatching the Planner, the Engine Core builds an enriched trigger prompt so the Planner
starts with all context in hand. See
[control-plane-engine-context-precomputation.md: Planner Context Pre-computation](./control-plane-engine-context-precomputation.md#planner-context-pre-computation)
for the prompt format, data sources, and error handling.

### Implementor Context Pre-computation

When dispatching the Implementor, the Engine Core builds an enriched trigger prompt so the
Implementor starts with task issue context in hand. When a linked PR exists (resume scenarios), the
prompt additionally includes PR diffs and prior review feedback. See
[control-plane-engine-context-precomputation.md: Implementor Context Pre-computation](./control-plane-engine-context-precomputation.md#implementor-context-pre-computation)
for the prompt format, data sources, and error handling.

### Reviewer Context Pre-computation

When dispatching the Reviewer, the Engine Core builds an enriched trigger prompt so the Reviewer
starts with task context, PR changes, and prior review feedback. See
[control-plane-engine-context-precomputation.md: Reviewer Context Pre-computation](./control-plane-engine-context-precomputation.md#reviewer-context-pre-computation)
for the prompt format, data sources, and error handling.

### SDK Types and Isolation

**SDK `AgentDefinition` type:**

```ts
type AgentDefinition = {
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  prompt: string;
  model?: "sonnet" | "opus" | "haiku" | "inherit";
  mcpServers?: AgentMcpServerSpec[]; // AgentMcpServerSpec is an SDK-provided type from @anthropic-ai/claude-agent-sdk
};
```

**SDK isolation:** No file outside `engine/agent-manager/` may import from
`@anthropic-ai/claude-agent-sdk`. The `QueryFactory` dependency injection seam (see below) ensures
the SDK is mockable for testing.

**QueryFactory:** The Agent Manager does not call `query()` directly. It receives a `QueryFactory`
function as a dependency, enabling test doubles that simulate the SDK's async message stream without
spawning real agent processes.

### Stream Accessor

The engine exposes live agent output streams, separate from the event emitter. Streaming output is
high-frequency data that should not flow through the discrete event channel.

| Method           | Parameters | Returns                                                                                                                                  |
| ---------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `getAgentStream` | Session ID | An `AsyncIterable<string>` of plain text output chunks for the running agent session, or `null` if no agent is running for this session. |

Each chunk is a plain text string extracted from the SDK session's message stream. The engine
subscribes to the SDK session internally, extracts text content from assistant messages, and
re-yields it as plain strings. Binary data, tool use metadata, and system messages are not surfaced
— only human-readable text output.

The TUI subscribes to agent streams directly for rendering in the detail pane. The stream ends when
the agent session completes (success, failure, or cancellation). Cancelling an agent session via
`cancelAgent` causes the stream's async iterable to complete. The Agent Manager subscribes to the
SDK session's output internally and exposes it through this method.

Planner streams are accessible through this interface — the session ID is provided in the
`agentStarted` event. Planner output (issue creation/updates) is also observable via the
IssuePoller.

### Agent Session Logging

When `logging.agentSessions` is enabled, the Agent Manager writes a human-readable transcript of
each agent session to disk. See
[control-plane-engine-agent-session-logging.md](./control-plane-engine-agent-session-logging.md) for
file lifecycle, log file format, message formatting, error handling, and log file path in events.

### Type Definitions

```ts
type QueryFactoryParams = {
  prompt: string; // enriched prompt (Planner, Implementor, Reviewer)
  agent: string; // agent name, e.g., 'planner'
  cwd: string;
  abortController: AbortController;
  modelOverride?: "sonnet" | "opus" | "haiku"; // overrides the agent definition's frontmatter model when present (used for complexity-based dispatch)
};

// The factory abstracts the SDK's query() call. The default implementation
// reads agent definition files from {repoRoot}/.claude/agents/{agent}.md,
// parses YAML frontmatter with gray-matter, passes the inline AgentDefinition
// to the SDK via the agents option, and appends project context files to the
// agent's system prompt. Session-level options (maxTurns) are read from
// frontmatter and passed to query() directly. If modelOverride is provided,
// it replaces the agent definition's model field in the AgentDefinition.
// settingSources is set to [] (see Known SDK Limitation).
// Test doubles return a mock Query without spawning a real agent process.
//
// buildQueryFactory(config: QueryFactoryConfig): QueryFactory
type QueryFactory = (params: QueryFactoryParams) => Query; // Query is from @anthropic-ai/claude-agent-sdk

type QueryFactoryConfig = {
  repoRoot: string; // absolute path to the git repository root
  bashValidatorHook: HookCallback; // PreToolUse hook for Bash command validation
  contextPaths: string[]; // paths relative to repoRoot — loaded and appended to every agent's system prompt (see Project Context Injection)
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
// crash recovery and completion-dispatch are mediated by the Engine Core
// (see control-plane-engine-recovery.md, [control-plane-engine.md: Completion-dispatch](./control-plane-engine.md#completion-dispatch)).
// The Agent Manager reports completions via callbacks provided by the Engine Core.
//
// Worktree creation and cleanup are handled by the Agent Manager. The Engine Core
// provides branchName and branchBase at dispatch time. The Agent Manager includes
// branchName in the agentFailed event for Implementor and Reviewer failures.

// HookCallback is from @anthropic-ai/claude-agent-sdk
// The engine constructs the bash validator hook and passes it to buildQueryFactory.

// getAgentStream returns null if no agent is running for the session
type AgentStream = AsyncIterable<string> | null;
```

## Acceptance Criteria

### Agent Lifecycle

- [ ] Given the `dispatchImplementor` command is received for issue N, when an agent is already
      running for issue N, then the skip is logged at `info` level and no new session is created.
- [ ] Given an agent is already running for issue N, when `dispatchReviewer` is received for issue
      N, then the skip is logged at `info` level and no new session is created.
- [ ] Given the `dispatchImplementor` command is received for an issue not in the IssuePoller
      snapshot, when the command is processed, then it is a no-op.
- [ ] Given the `dispatchImplementor` command is received for an issue whose status is not in the
      accepted set (`pending`, `unblocked`, `needs-changes`, or `in-progress` with no running
      agent), when the command is processed, then it is a no-op.
- [ ] Given an Implementor or Reviewer agent session fails, when the `agentFailed` event is emitted,
      then it includes the session ID and branch name (the branch persists after worktree cleanup).
- [ ] Given an Implementor or Reviewer agent session completes (success or failure), when cleanup
      runs, then the worktree is removed and the branch is preserved.
- [ ] Given the engine dispatches any agent and `contextPaths` is empty, when the `QueryFactory`
      creates the session, then the agent's original prompt is used as-is with no context appended.
- [ ] Given the engine dispatches any agent and a context file in `contextPaths` cannot be read
      (missing or permissions error), when the `QueryFactory` attempts to create the session, then
      the error propagates to the caller and the session is not created (same behavior as agent
      definition file loading failures).
- [ ] Given an agent definition file includes a `maxTurns` frontmatter field, when `query()` is
      called, then the `maxTurns` session option is set to the parsed integer value.
- [ ] Given an agent definition file does not include a `maxTurns` frontmatter field, when `query()`
      is called, then the `maxTurns` option is omitted (SDK default applies).
- [ ] Given `modelOverride` is provided in `QueryFactoryParams`, when the `QueryFactory` constructs
      the `AgentDefinition`, then the `model` field uses the override value instead of the
      frontmatter value.
- [ ] Given the engine dispatches an Implementor or Reviewer, when `yarn install` fails in the
      worktree, then the worktree is removed, `agentFailed` is emitted, and no agent session is
      created.
- [ ] Given the engine dispatches an Implementor for issue N with no linked PR, when the worktree is
      created, then it uses a fresh branch `issue-<N>-<timestamp>` from `main` and `cwd` is set to
      `.worktrees/issue-<N>-<timestamp>`.
- [ ] Given the engine dispatches an Implementor for issue N with a linked PR, when the worktree is
      created, then it uses the PR's `headRefName` and `cwd` is set to `.worktrees/<headRefName>`.
- [ ] Given the engine dispatches a Reviewer for issue N, when the worktree is created, then the
      Agent Manager fetches the PR branch from the remote (`git fetch origin <headRefName>`) and
      creates the worktree from the remote tracking ref (`origin/<headRefName>`). `cwd` is set to
      `.worktrees/<headRefName>`.
- [ ] Given the engine codebase, when inspected, then no file outside `engine/agent-manager/`
      imports from `@anthropic-ai/claude-agent-sdk` or `gray-matter`.
- [ ] Given the bash validator hook receives a Bash command matching a blocklist pattern, when the
      hook evaluates the command, then it returns a block decision with the matched pattern in the
      reason.
- [ ] Given the bash validator hook receives a Bash command with all segments having allowlisted
      prefixes, when the hook evaluates the command, then it returns an approve decision.
- [ ] Given `getAgentStream` is called with a session ID for a running agent, when the agent
      produces output, then the returned async iterable yields output chunks.
- [ ] Given `getAgentStream` is called with a session ID for which no agent is running, when called,
      then it returns `null`.
- [ ] Given a Planner session is running, when `getAgentStream` is called with the Planner's session
      ID, then the returned async iterable yields output chunks.

### Context Pre-computation

See `control-plane-engine-context-precomputation.md` for all planner, implementor, and reviewer
context pre-computation acceptance criteria.

### Agent Session Logging

See `control-plane-engine-agent-session-logging.md` for all agent session logging acceptance
criteria.

## Known Limitations

- **`settingSources` SDK workaround:** The SDK's `settingSources: ['project']` resolution hangs when
  `cwd` is a git worktree (the `.git` file vs directory issue). The engine sets `settingSources: []`
  and handles all project-level concerns manually: agent definitions via inline loading, project
  context (CLAUDE.md) via `contextPaths`, hooks via the programmatic `hooks` option, and
  `permissionMode` via the explicit option. See the "Known SDK limitation" paragraph in
  [SDK Session Configuration](#sdk-session-configuration) for the full workaround rationale.

## Dependencies

- `control-plane-engine.md` — Parent engine spec (event types, command interface, configuration)
- `control-plane-engine-recovery.md` — Crash recovery behavior after agent failure
- `control-plane-engine-context-precomputation.md` — Planner, Implementor, and Reviewer enriched
  trigger prompts
- `control-plane-engine-agent-session-logging.md` — Agent session transcript logging
- `control-plane.md` — Parent architecture spec (worktree isolation)
- `@anthropic-ai/claude-agent-sdk` (≥0.2.x) — v1 `query()` API for agent invocations
- `gray-matter` — YAML frontmatter parser for agent definition files
- `agent-hook-bash-validator.md` — Normative validation rules for the Bash tool hook

## References

- [control-plane-engine.md: Dispatch Logic](./control-plane-engine.md#dispatch-logic) — When agents
  are dispatched
- [control-plane-engine.md: Configuration](./control-plane-engine.md#configuration) — Agent names,
  `maxAgentDuration`, logging settings
- `control-plane-engine-recovery.md` — Crash recovery triggered after agent completion
- `control-plane-engine-context-precomputation.md` — Enriched trigger prompt formats and data
  sources
- `control-plane-engine-agent-session-logging.md` — Log file lifecycle, format, and error handling
- `agent-hook-bash-validator-script.md` — Shell script implementation of the bash validator (for
  interactive use outside the control plane)
