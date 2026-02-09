---
title: Control Plane Engine
version: 0.9.0
last_updated: 2026-02-09
status: approved
---

# Control Plane Engine

## Overview

The engine is the core module of the control plane. It orchestrates independent pollers that monitor GitHub for state changes, classifies detected changes into dispatch tiers, manages agent sessions, and handles recovery. The engine has no knowledge of the TUI — it exposes four interfaces (event emitter, command interface, query interface, and stream accessor) that the TUI (or any other consumer) can use.

## Constraints

- Must not import or reference the TUI module.
- Must not crash on transient errors (GitHub API failures, network errors). Log and retry next cycle.
- Must not dispatch more than one agent per task issue at a time.
- Must not auto-dispatch the Planner for specs without `status: approved` in frontmatter.
- Must reset `status:in-progress` issues to `status:pending` when no agent is running for them (startup recovery and crash recovery).
- Must use `@octokit/rest` with `@octokit/auth-app` as the authentication strategy for all GitHub API interactions. Octokit is an implementation detail of the GitHub Client adapter — all engine code interacts with the `GitHubClient` interface, never with Octokit directly. No type assertions (`as`) are permitted at the adapter boundary or anywhere `GitHubClient` is consumed.
- Must use `@anthropic-ai/claude-agent-sdk` (≥0.2.x) for all agent invocations via the v1 `query()` API.
- Must detect spec changes remotely (via GitHub API), not from the local filesystem.
- GitHub write operations are limited to recovery (status label resets). All other writes are performed by agents.

## Specification

### Architecture

The engine consists of three layers:

```mermaid
flowchart TD
    subgraph Pollers["Pollers (independent)"]
        IP["IssuePoller"]
        SP["SpecPoller"]
    end

    subgraph Core["Engine Core"]
        Dispatch["Dispatch Logic"]
        AM["Agent Manager"]
    end

    subgraph Interfaces
        EE["Event Emitter"]
        CI["Command Interface"]
        QI["Query Interface"]
        SA["Stream Accessor"]
    end

    IP -- "issueStatusChanged\nremoved issues" --> Dispatch
    SP -- "batch results" --> Core
    Dispatch -- "dispatch decisions" --> AM
    AM -- "agent events" --> EE
    AM -- "agent streams" --> SA
    Dispatch -- "dispatch / notification events" --> EE
    CI -- "dispatch / cancel / shutdown" --> Core
    QI -- "getIssueDetails / getPRForIssue" --> Core
```

- **Pollers** — Independent units that each monitor a single data source on their own interval. Pollers are pure sensors — they detect state changes and report results. IssuePoller emits events directly; SpecPoller returns batched results to the Engine Core. They do not make dispatch decisions.
- **Engine Core** — Receives poller events, classifies them by dispatch tier, and manages agent sessions. Owns dispatch policy and agent lifecycle. Engine Core sub-components are specified in dedicated sub-specs: Agent Manager (`control-plane-engine-agent-manager.md`), Recovery (`control-plane-engine-recovery.md`), Planner Cache (`control-plane-engine-planner-cache.md`).
- **Interfaces** — Event emitter (outbound state changes), command interface (inbound user actions), query interface (on-demand data fetching), and stream accessor (live agent output). All consumed by the TUI.

Each poller maintains its own snapshot slice. A failure in one poller does not affect others.

### GitHub Client

The engine accesses GitHub through a `GitHubClient` interface — a narrow, explicitly-typed contract covering only the API methods the engine uses. The `createGitHubClient` factory constructs an Octokit instance internally and returns a thin adapter that satisfies `GitHubClient` without type assertions.

**Why a wrapper:** Octokit's deeply generic types do not structurally match a narrow interface, even when the methods are compatible at runtime. Casting (`as unknown as GitHubClient`) would hide real mismatches. Instead, each adapter method explicitly calls the corresponding Octokit method and returns the result through a properly-typed function signature. The wrappers are 1:1 delegations — no transformation, no error mapping, no retry logic. They exist solely to bridge the type gap.

**Factory:** `createGitHubClient(config: GitHubClientConfig): GitHubClient`

The factory:

1. Creates an `Octokit` instance with `createAppAuth` as the auth strategy, using the provided `appID`, `privateKey`, and `installationID`.
2. Returns an object satisfying `GitHubClient` where each method delegates to the corresponding Octokit method.

**Module location:** `engine/github-client/`. The module contains:

- `types.ts` — `GitHubClientConfig`, `GitHubClient`, and all param/result types.
- `create-github-client.ts` — The adapter factory. Imports `Octokit` from `@octokit/rest` and `createAppAuth` from `@octokit/auth-app`. This is the only file in the engine that imports from `@octokit/*`.

**Octokit isolation:** No file outside `engine/github-client/` may import from `@octokit/rest` or `@octokit/auth-app`. This ensures Octokit is a swappable implementation detail.

**Caller responsibility:** The caller reads the private key from disk and passes the PEM content as a string. The adapter does not perform filesystem I/O.

**Auth validation:** `@octokit/auth-app` validates credentials lazily — the first API call triggers JWT creation and token exchange, not the `createGitHubClient` call itself. If credentials are invalid (bad key, wrong app ID, etc.), the first poller cycle will fail. The engine's error handling (log and retry next cycle) applies, but since invalid credentials never self-heal, this will fail indefinitely. This is acceptable for v1 — invalid credentials are a deployment misconfiguration, caught immediately on first cycle. The operator must fix the config and restart.

### Pollers

The engine uses two independent pollers: the **IssuePoller** monitors GitHub Issues for `status:*` label changes, and the **SpecPoller** monitors the specs directory on the default branch for file changes via the GitHub Trees API. Each runs on its own interval and maintains its own snapshot. See `control-plane-engine-pollers.md` for full poll cycle behavior, snapshot state, change detection, closed issue detection, startup burst, first-cycle execution, snapshot seeding, and type definitions.

### Dispatch Logic

The engine core listens to poller events and classifies each into a dispatch tier. Dispatch logic is centralized — pollers never dispatch agents.

#### Auto-dispatch

The engine invokes the agent automatically with no user action.

| Poller Event | Agent | Condition |
|-------------|-------|-----------|
| `specChanged` | Planner | Spec frontmatter `status` is `approved` |
| `issueStatusChanged` to `status:review` | Reviewer | No agent already running for this issue |

The Planner is invoked once per SpecPoller cycle with all changed (and approved) spec paths batched into a single invocation. The Engine Core receives the full batch from the SpecPoller synchronously and passes approved paths to a single Planner dispatch.

**Planner concurrency guard:** Only one Planner session may run at a time. If a SpecPoller cycle detects changes while a Planner is already running, the engine emits `agentSkipped` for the Planner and defers the batch. The Engine Core maintains a deferred paths buffer (a set of file paths, deduplicated) for this purpose. On each subsequent SpecPoller cycle, the Engine Core merges the deferred buffer with the new cycle's results (union, deduplicated). The approval filter (`status: approved`) is applied to the merged set at dispatch time — paths whose frontmatter status changed to non-approved since deferral are dropped. The deferred buffer is cleared when the Planner is successfully dispatched. If the Planner session fails, the Engine Core re-adds the dispatched spec paths to the deferred buffer so they are included in the next dispatch attempt rather than being lost until restart.

**Planner idempotency:** The engine does not prevent re-dispatch for the same spec (e.g., a whitespace-only change to an approved spec will re-trigger the Planner). The Planner agent definition is responsible for idempotency — checking existing issues before creating new ones. See `agent-planner.md`.

The Reviewer is invoked per issue — one Reviewer per issue that entered `status:review`.

#### User-dispatch

The engine emits a `dispatchReady` event surfacing the issue to the TUI. The user decides when (or whether) to dispatch.

| Poller Event | Agent |
|-------------|-------|
| `issueStatusChanged` to `status:pending` | Implementor |
| `issueStatusChanged` to `status:unblocked` | Implementor |
| `issueStatusChanged` to `status:needs-changes` | Implementor |

User-dispatch items are surfaced on first detection (status differs from snapshot). They are not re-surfaced on subsequent polls if the status has not changed again.

#### Notify-only

The engine emits a notification event. No agent is dispatched.

| Poller Event | Notification |
|-------------|-------------|
| `issueStatusChanged` to `status:needs-refinement` | Clipboard-ready CLI command for the Human to address the spec issue. Includes resolution guidance: "After amending the spec, change the label to `status:unblocked`." `contextURL`: issue URL. |
| `issueStatusChanged` to `status:blocked` | Notification with issue URL for the Human to investigate the blocker. Includes resolution guidance: "After resolving the blocker, change the label to `status:unblocked`." `contextURL`: issue URL. |
| `issueStatusChanged` to `status:approved` | Notification that the issue is ready for Human to merge. `contextURL`: issue URL. The TUI is responsible for asynchronous PR URL lookup (see `control-plane-tui.md`). |

**Clipboard command format** for `status:needs-refinement`:

```
claude -p "Use /spec-writing to address the spec refinement needed for issue #<N>. See blocker comment: https://github.com/<owner>/<repo>/issues/<N>"
```

This gives the Human a ready-to-paste command to kick off a spec amendment workflow outside the control plane. The `/spec-writing` skill handles the structured spec authoring process.

Notifications are dismissed automatically when the underlying issue's status changes to a different value on a subsequent poll.

**Event ordering:** For each status change, the Engine Core emits `issueStatusChanged` before any dispatch-tier event (`dispatchReady`, `notification`, or auto-dispatch trigger). This ensures the TUI's store has the updated issue state before processing dispatch events that reference it.

**Dispatch fallthrough:** Status changes to values not listed in any dispatch tier (e.g., `in-progress`) trigger no dispatch action. The `issueStatusChanged` event is still emitted so the TUI can update the issue's state indicator.

**Removed issue orchestration:** When the IssuePoller reports that an issue has been removed (closed or `task:implement` label removed), the Engine Core handles the response: (1) if an agent is running for the issue, cancel the agent session and emit `agentFailed` (treated as cancellation — worktree preserved if Implementor); then (2) emit `issueRemoved`. This ordering guarantees `agentFailed` is emitted before `issueRemoved` for the same issue, so the TUI can process the failure before the issue is removed from its store.

### Event Emitter

The engine emits typed events for discrete state changes. Events drive reactive updates in the TUI's Zustand store. Streaming agent output is handled separately via the stream accessor (see below).

| Event | Payload | Emitted By |
|-------|---------|-----------|
| `issueStatusChanged` | Issue number, title, old status, new status, priority label, creation date, `isRecovery` flag (true for synthetic events from recovery) | IssuePoller (or Engine Core for synthetic recovery events) |
| `specChanged` | File path, frontmatter status, change type (added/modified), commit SHA | Engine Core (from SpecPoller results) |
| `agentStarted` | Agent type, issue number or spec paths, session ID | Agent Manager |
| `agentCompleted` | Agent type, issue number or spec paths, session ID, log file path (when logging enabled) | Agent Manager |
| `agentFailed` | Agent type, issue number or spec paths, error details, session ID, worktree path (Implementor only), log file path (when logging enabled) | Agent Manager |
| `agentSkipped` | Agent type, issue number or spec paths (deferred) | Agent Manager (per-issue guard) or Engine Core (Planner concurrency guard) |
| `dispatchReady` | Issue number, status label | Dispatch Logic |
| `notification` | Issue number, status label, `contextURL` (issue URL), `clipboardCommand` (optional — present for `needs-refinement`, absent for `blocked` and `approved`), `resolutionGuidance` (optional — present for `needs-refinement` and `blocked`, absent for `approved`). Note: this is a specific engine event type for notify-only tier issues, distinct from the TUI's "notification" concept (the TUI surfaces all engine events as notification entries in the notifications pane). | Dispatch Logic |
| `notificationDismissed` | Issue number | Dispatch Logic |
| `issueRemoved` | Issue number | Engine Core (in response to IssuePoller reporting a removed issue) |
| `recoveryPerformed` | Issue number, old status, new status | Engine Core (startup recovery and crash recovery) |

### Command Interface

The engine accepts commands that trigger side effects.

| Command | Parameters | Effect |
|---------|-----------|--------|
| `dispatchImplementor` | Issue number | Creates an Implementor agent session for the given issue (if no agent is already running for it). No-op if the issue number is not in the IssuePoller snapshot, or if an agent is already running for the issue. Accepted when the issue's status is in the user-dispatch set (`pending`, `unblocked`, `needs-changes`) or `in-progress` with no running agent (transient state before crash recovery resets it). |
| `dispatchReviewer` | Issue number | Creates a Reviewer agent session for the given issue (if no agent is already running for it). No-op if the issue number is not in the IssuePoller snapshot or if the issue's status is not `review`. No transient-state exception is needed (unlike `dispatchImplementor`) — Reviewers do not change the issue status to `in-progress`. Used for manual retry after Reviewer failure. |
| `cancelAgent` | Issue number | Cancels the running agent session for the given issue. The engine determines agent-specific behavior (recovery, worktree handling) from its internal tracking of which agent type is running. For Implementors: performs crash recovery if the issue is still `status:in-progress`, preserves the worktree. For Reviewers: no recovery needed (issue stays `status:review`; user can retry via `dispatchReviewer`). Emits `agentFailed` with a cancellation error. No-op if no agent is running. |
| `cancelPlanner` | None | Cancels the running Planner session if one exists. Emits `agentFailed` with a cancellation error. No-op if no Planner is running. Note: `cancelPlanner` is not exposed in the TUI — there is no keybinding to cancel the Planner. A hung Planner can be stopped by quitting the control plane (which triggers the graceful shutdown sequence, which cancels all agents after `shutdownTimeout`) or by waiting for `maxAgentDuration` timeout. This is a known v1 limitation. |
| `shutdown` | None | Initiates graceful shutdown |

### Query Interface

The engine provides on-demand data fetching for display purposes. Queries are read-only and fetch data via `GitHubClient` when called. Results are not cached by the engine — the TUI manages its own caching in the Zustand store.

| Query | Parameters | Returns |
|-------|-----------|---------|
| `getIssueDetails` | Issue number | Issue body (objective, spec reference, scope, acceptance criteria), labels, creation date |
| `getPRForIssue` | Issue number | PR number, title, changed files count, CI status, URL. Returns `null` if no linked PR exists. |

PR linkage is determined by searching for a PR whose body contains a closing keyword referencing the issue number. The match is case-insensitive and supports GitHub's closing keywords: `Closes`, `Fixes`, `Resolves` (and their conjugations: `Close`, `Closed`, `Fix`, `Fixed`, `Resolve`, `Resolved`). The issue number must be followed by whitespace, punctuation, or end of line — not additional digits (word-boundary match). If multiple open PRs match, the first match (by PR number, ascending) is used. Branch name matching is not used because the Implementor renames the working branch (`issue-<N>`) to the convention format (`<type>/<N>-<description>`) before pushing.

**Pagination:** `getIssueDetails` fetches the issue directly via `issues.get` (no pagination concern). `getPRForIssue` lists open PRs via `pulls.list` with `per_page: 100` without pagination. The IssuePoller's `issues.listForRepo` call also uses `per_page: 100` without pagination. Repositories with more than 100 open task issues or 100 open PRs will have results silently truncated. This is a known v1 limitation — acceptable for the expected scale of managed repositories.

**Query normalization:** The `GitHubClient` param/result types mirror Octokit's response shapes (e.g., `IssueData.body` is `string | null`, `IssueData.labels` is `(string | { name?: string })[]`). The query functions normalize these into the cleaner result types consumed by the TUI:

- `getIssueDetails` — Coerces `body` from `string | null` to `string` (empty string for `null`). Extracts label names from the `labels` array: for each entry, uses the string directly if it is a bare string, or extracts the `name` property if it is an object with a `name` string. Entries that are objects without a `name` property are discarded.
- `getPRForIssue` — Lists open PRs (`per_page: 100`), finds the one whose body matches a closing keyword for `#<N>`, then fetches the full PR via `pulls.get` to obtain `head.sha`. Uses `head.sha` to query CI status via `repos.getCombinedStatusForRef` and `checks.listForRef`. Combines both into the `ciStatus` field using the following logic:
  - `'failure'` — if `getCombinedStatusForRef` reports `state: 'failure'`, or any check run has `conclusion` of `'failure'`, `'cancelled'`, or `'timed_out'`.
  - `'pending'` — if any check run has `status` other than `'completed'` (i.e., `'queued'` or `'in_progress'`), or if `getCombinedStatusForRef` reports `state: 'pending'`, or if both endpoints report `total_count: 0` (no CI configured).
  - `'success'` — if `getCombinedStatusForRef` reports `state: 'success'` (or `total_count: 0`) and all check runs have `status: 'completed'` with `conclusion: 'success'`.

### Agent Manager

The Agent Manager handles agent session lifecycle — creating sessions via the Claude Agent SDK, tracking active sessions, monitoring completion, managing worktrees, exposing live agent output streams, and handling session logging. See `control-plane-engine-agent-manager.md` for agent lifecycle steps, agent definition loading, programmatic hooks (bash validator), SDK session configuration, stream accessor, agent session logging, and related type definitions. The `AgentManagerConfig` type (defined in the sub-spec) carries `repoRoot`, `maxAgentDuration`, and logging settings derived from `EngineConfig`.

### Recovery

The engine performs recovery to ensure no issue is permanently stuck in `status:in-progress`. Recovery resets stale issues to `status:pending` and emits synthetic events. See `control-plane-engine-recovery.md` for startup recovery, crash recovery, and Reviewer failure behavior.

### Planner Cache

The engine persists a lightweight cache to prevent redundant Planner runs across restarts. See `control-plane-engine-planner-cache.md` for cache format, startup seeding, cache write behavior, deferred paths interaction, and error handling.

### Repository Root Resolution

The engine must resolve the git repository root at startup. This path is used for:

- Worktree creation (`.worktrees/issue-<N>` is relative to repo root)
- Agent definition loading (`.claude/agents/<name>.md` is read from repo root)
- Planner cache file location (`.agentic-workflow-cache.json` at repo root)
- Relative `logsDir` resolution

**Resolution:** The `createEngine` factory resolves the repository root using `git rev-parse --show-toplevel` (via `execFileSync`). This is a synchronous call that runs once at engine construction time.

**Why not `process.cwd()`:** In a Yarn workspace, `process.cwd()` resolves to the package directory (e.g., `agentic-workflow/`), not the repository root. Using it would create worktrees inside the package directory and fail to find `.claude/agents/` for agent definition loading.

**Override:** The `createEngine` factory accepts an optional `repoRoot` dependency injection for testing. When not provided, it uses `git rev-parse --show-toplevel`.

### Configuration

The engine reads configuration from a TypeScript config file (`agentic-workflow.config.ts`):

#### Engine

| Setting | Type | Description | Default |
|---------|------|-------------|---------|
| `repository` | `string` | GitHub repository in `owner/repo` format | Required |
| `githubAppID` | `number` | GitHub App numeric ID | Required |
| `githubAppPrivateKeyPath` | `string` | Path to the PEM private key file | Required |
| `githubAppInstallationID` | `number` | Installation ID for the target repository | Required |
| `logLevel` | `string` | Logging verbosity (`debug`, `info`, `error`) | `info` |
| `shutdownTimeout` | `number` | Seconds to wait for agents during shutdown | `300` |

At startup, the engine parses `repository` into `owner` and `repo` strings (split on `/`). It reads the private key file from `githubAppPrivateKeyPath` and passes the PEM content string to `createGitHubClient` along with `githubAppID` and `githubAppInstallationID`. The returned `GitHubClient` instance, along with `owner` and `repo`, is then passed to all pollers, queries, and recovery as dependencies. Authentication is handled internally by `@octokit/auth-app` (JWT creation, installation token exchange, automatic token refresh) — no manual token management is needed. The App must have `issues:write` (for recovery label resets) and `contents:read` (for tree/file access) permissions.

#### IssuePoller

| Setting | Type | Description | Default |
|---------|------|-------------|---------|
| `pollInterval` | `number` | Seconds between poll cycles | `30` |

#### SpecPoller

| Setting | Type | Description | Default |
|---------|------|-------------|---------|
| `pollInterval` | `number` | Seconds between poll cycles | `60` |
| `specsDir` | `string` | Path to the specs directory (relative to repo root) | `docs/specs/` |
| `defaultBranch` | `string` | Branch to monitor for spec changes | `main` |

#### Agents

| Setting | Type | Description | Default |
|---------|------|-------------|---------|
| `agentPlanner` | `string` | Agent name for the Planner. The engine reads `.claude/agents/<name>.md` from the repository root, parses it, and passes the definition inline to the SDK. | `'planner'` |
| `agentImplementor` | `string` | Agent name for the Implementor. The engine reads `.claude/agents/<name>.md` from the repository root, parses it, and passes the definition inline to the SDK. | `'implementor'` |
| `agentReviewer` | `string` | Agent name for the Reviewer. The engine reads `.claude/agents/<name>.md` from the repository root, parses it, and passes the definition inline to the SDK. | `'reviewer'` |
| `maxAgentDuration` | `number` | Maximum seconds an agent session can run before being cancelled. Applies to all agent types. When exceeded, the engine cancels the session and performs crash recovery. | `1800` (30 min) |

#### Logging

| Setting | Type | Description | Default |
|---------|------|-------------|---------|
| `agentSessions` | `boolean` | Enable writing agent session transcripts to disk. When enabled, the Agent Manager writes one log file per agent session capturing the full SDK message stream. | `false` |
| `logsDir` | `string` | Directory for agent session log files. Absolute paths are used as-is. Relative paths are resolved from `repoRoot` (see Repository Root Resolution). Created automatically if it does not exist. | `logs` |

When `agentSessions` is `false` (default), no log files are created and agent events do not include `logFilePath`. The `logsDir` setting is ignored when `agentSessions` is disabled.

### Logging

The engine logs structured events at the following levels:

| Event | Level | Content |
|-------|-------|---------|
| Startup | `info` | Configuration summary, initial state counts |
| Poller cycle start | `debug` | Poller name, cycle number |
| Change detected | `info` | Poller name, change type, issue number or file path |
| Agent invoked | `info` | Agent type, issue number or file path, session ID |
| Agent skipped (already running) | `info` | Agent type, issue number |
| Agent completed | `info` | Agent type, issue number |
| Agent failed | `error` | Agent type, issue number, error details |
| No changes detected | `debug` | Poller name, cycle number |
| GitHub API error | `error` | Poller name, error details |
| Recovery performed | `info` | Issue number, old status, new status |
| Shutdown initiated | `info` | Reason |
| Shutdown complete | `info` | Agents terminated count |
| Planner cache loaded | `debug` | Loaded tree SHA and file count, or "cache miss — cold start" |
| Planner cache write failed | `error` | Error details |
| Agent session transcript | (file) | Full SDK message stream written to `{logsDir}/{timestamp}-{agentType}[-{context}].log`. One file per session. Only when `logging.agentSessions` is enabled. |

Entries with level `(file)` represent disk writes handled by the Agent Manager, not the structured logger. See `control-plane-engine-agent-manager.md` § Agent Session Logging for format details.

### Error Handling

The engine must not crash on transient errors. Each error type has a defined recovery behavior:

| Error | Behavior |
|-------|----------|
| GitHub API error (in any poller) | Log at `error` level. Skip this cycle for the affected poller only. Other pollers continue unaffected. Retry next cycle. |
| GitHub API rate limit (HTTP 403/429) | Treated as a GitHub API error — same log-and-skip behavior. The poll interval provides natural backoff. No explicit rate limit tracking or adaptive throttling in v1. GitHub App installation tokens have a 5,000 request/hour limit; with default poll intervals (30s issues, 60s specs), steady-state usage is well within this budget. |
| Agent definition file missing, unreadable, or malformed YAML | Treated as agent session creation failure — the error propagates before the session is created. Logged at `error` level. Not a transient error (requires fixing the agent file), but the engine continues operating. |
| Repository root resolution failure (`git rev-parse` fails) | Log at `error` level and exit. The engine cannot operate without a valid repository root. This is a deployment misconfiguration (not running inside a git repository). |
| Agent session creation failure | Log at `error` level. Do not mark agent as running. Next cycle will re-detect the state and retry dispatch. |
| Agent session failure | Log at `error` level with error details. Perform crash recovery if applicable. |
| Config file missing or invalid | Log at `error` level and exit. This is not a transient error. |
| Planner cache read error | Log at `debug` level. Treat as cold start — SpecPoller starts with empty snapshot. Non-fatal. |
| Planner cache write error | Log at `error` level. Engine continues — next restart cannot skip Planner. Non-fatal. |

### Graceful Shutdown

When a shutdown command is received:

1. Log shutdown initiation.
2. Stop all pollers (no new cycles).
3. Wait for all running agent sessions to complete, up to `shutdownTimeout` seconds.
4. If timeout is reached, cancel remaining agent sessions (using `cancelAgent` for task agents and `cancelPlanner` for the Planner internally).
5. Log shutdown completion and exit.

### Type Definitions

Reference types for the engine's public interfaces. These define the contracts that the TUI (or any consumer) relies on.

#### GitHub Client

```ts
type GitHubClientConfig = {
  appID: number;
  privateKey: string; // PEM file content (caller reads from disk)
  installationID: number;
};

// createGitHubClient(config: GitHubClientConfig): GitHubClient

type GitHubClient = {
  issues: {
    get(params: IssuesGetParams): Promise<IssuesGetResult>;
    listForRepo(params: IssuesListForRepoParams): Promise<IssuesListForRepoResult>;
    addLabels(params: IssuesAddLabelsParams): Promise<IssuesAddLabelsResult>;
    removeLabel(params: IssuesRemoveLabelParams): Promise<IssuesRemoveLabelResult>;
  };
  pulls: {
    list(params: PullsListParams): Promise<PullsListResult>;
    get(params: PullsGetParams): Promise<PullsGetResult>;
  };
  repos: {
    getCombinedStatusForRef(params: ReposGetCombinedStatusParams): Promise<ReposGetCombinedStatusResult>;
    getContent(params: ReposGetContentParams): Promise<ReposGetContentResult>;
  };
  checks: {
    listForRef(params: ChecksListForRefParams): Promise<ChecksListForRefResult>;
  };
  git: {
    getTree(params: GitGetTreeParams): Promise<GitGetTreeResult>;
    getRef(params: GitGetRefParams): Promise<GitGetRefResult>;
  };
};

// Param/result types (e.g., IssuesGetParams, PullsGetResult) are defined
// in engine/github-client/types.ts. Each is a named type with only the
// fields the engine uses — narrower than Octokit's full response shapes.
```

#### Events

```ts
type IssueStatusChangedEvent = {
  type: 'issueStatusChanged';
  issueNumber: number;
  title: string;
  oldStatus: string | null; // null on first detection
  newStatus: string;
  priorityLabel: string;
  createdAt: string; // ISO 8601
  isRecovery?: boolean; // true when emitted as synthetic event from crash recovery
};

type SpecChangedEvent = {
  type: 'specChanged';
  filePath: string;
  frontmatterStatus: string;
  changeType: 'added' | 'modified';
  commitSHA: string; // Always non-empty — events are only emitted when changes are detected. HEAD commit on default branch (for diff URLs).
};

type AgentType = 'planner' | 'implementor' | 'reviewer';

type AgentStartedEvent = {
  type: 'agentStarted';
  agentType: AgentType;
  issueNumber?: number; // present for Implementor, Reviewer
  specPaths?: string[]; // present for Planner
  sessionID: string;
};

type AgentCompletedEvent = {
  type: 'agentCompleted';
  agentType: AgentType;
  issueNumber?: number;
  specPaths?: string[];
  sessionID: string;
  logFilePath?: string; // present when logging.agentSessions is enabled
};

type AgentFailedEvent = {
  type: 'agentFailed';
  agentType: AgentType;
  issueNumber?: number;
  specPaths?: string[];
  error: string;
  sessionID: string;
  worktreePath?: string; // present for Implementor
  logFilePath?: string; // present when logging.agentSessions is enabled
};

type AgentSkippedEvent = {
  type: 'agentSkipped';
  agentType: AgentType;
  issueNumber?: number; // present for Implementor, Reviewer
  specPaths?: string[]; // present for Planner (deferred paths)
};

type DispatchReadyEvent = {
  type: 'dispatchReady';
  issueNumber: number;
  statusLabel: string;
};

type NotificationEvent = {
  type: 'notification';
  issueNumber: number;
  statusLabel: string;
  clipboardCommand?: string; // present for needs-refinement, absent for blocked and approved
  contextURL: string; // issue URL for all notification statuses (needs-refinement, blocked, approved)
  resolutionGuidance?: string; // The engine guarantees this is always present when statusLabel is 'needs-refinement' or 'blocked'; absent only for 'approved'.
  // blocked: "After resolving the blocker, change the label to status:unblocked."
  // needs-refinement: "After amending the spec, change the label to status:unblocked."
};

type NotificationDismissedEvent = {
  type: 'notificationDismissed';
  issueNumber: number;
};

type IssueRemovedEvent = {
  type: 'issueRemoved';
  issueNumber: number;
};

type RecoveryPerformedEvent = {
  type: 'recoveryPerformed';
  issueNumber: number;
  oldStatus: string;
  newStatus: string;
};

type EngineEvent =
  | IssueStatusChangedEvent
  | SpecChangedEvent
  | AgentStartedEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentSkippedEvent
  | DispatchReadyEvent
  | NotificationEvent
  | NotificationDismissedEvent
  | IssueRemovedEvent
  | RecoveryPerformedEvent;
```

#### Commands

```ts
type DispatchImplementorCommand = {
  command: 'dispatchImplementor';
  issueNumber: number;
};

type DispatchReviewerCommand = {
  command: 'dispatchReviewer';
  issueNumber: number;
};

type CancelAgentCommand = {
  command: 'cancelAgent';
  issueNumber: number;
};

type CancelPlannerCommand = {
  command: 'cancelPlanner';
};

type ShutdownCommand = {
  command: 'shutdown';
};

type EngineCommand = DispatchImplementorCommand | DispatchReviewerCommand | CancelAgentCommand | CancelPlannerCommand | ShutdownCommand;
```

#### Query Results

```ts
// Normalized from GitHubClient response shapes:
// - body: coerced from string | null to string (empty string for null)
// - labels: from (string | { name?: string })[] — bare strings kept as-is,
//   objects yield their name property, objects without name are discarded
type IssueDetailsResult = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string; // ISO 8601
};

// ciStatus derived from pulls.get → head.sha → repos.getCombinedStatusForRef + checks.listForRef
type PRDetailsResult = {
  number: number;
  title: string;
  changedFilesCount: number;
  ciStatus: 'pending' | 'success' | 'failure';
  url: string;
} | null;
```

#### Stream / Agent Manager

See `control-plane-engine-agent-manager.md` § Type Definitions for `AgentStream`, `QueryFactoryParams`, `QueryFactory`, `QueryFactoryConfig`, `AgentManagerConfig`, and `HookCallback`. See `control-plane-engine-agent-manager.md` § SDK Session Configuration for `AgentDefinition`.

#### SpecPoller

See `control-plane-engine-pollers.md` § Type Definitions for `SpecPollerFileEntry`, `SpecPollerSnapshot`, `SpecChange`, and `SpecPollerBatchResult`.

#### Configuration

```ts
type EngineConfig = {
  repository: string; // owner/repo format
  githubAppID: number;
  githubAppPrivateKeyPath: string;
  githubAppInstallationID: number;
  logLevel?: 'debug' | 'info' | 'error'; // default: 'info'
  shutdownTimeout?: number; // seconds, default: 300
  issuePoller?: {
    pollInterval?: number; // seconds, default: 30
  };
  specPoller?: {
    pollInterval?: number; // seconds, default: 60
    specsDir?: string; // default: 'docs/specs/'
    defaultBranch?: string; // default: 'main'
  };
  agents?: {
    agentPlanner?: string; // agent name, default: 'planner'
    agentImplementor?: string; // agent name, default: 'implementor'
    agentReviewer?: string; // agent name, default: 'reviewer'
    maxAgentDuration?: number; // seconds, default: 1800
  };
  logging?: {
    agentSessions?: boolean; // default: false
    logsDir?: string; // default: 'logs'
  };
};
```

#### Engine Interface

The public interface consumed by the TUI's `useEngine()` hook.

```ts
type StartupResult = {
  issueCount: number;
  recoveriesPerformed: number;
};

type Engine = {
  start(): Promise<StartupResult>; // resolves after planner cache load, startup recovery, and first IssuePoller and SpecPoller cycles complete
  on(handler: (event: EngineEvent) => void): () => void; // returns unsubscribe function
  send(command: EngineCommand): void;
  getIssueDetails(issueNumber: number): Promise<IssueDetailsResult>;
  getPRForIssue(issueNumber: number): Promise<PRDetailsResult>;
  getAgentStream(issueNumber: number): AgentStream;
};

// Startup contract: Callers MUST subscribe to the event emitter (via `on()`)
// before calling `start()`. Events emitted during startup recovery are
// delivered synchronously within the `start()` call. If the caller subscribes
// after `start()` resolves, startup recovery events are lost.
```

## Acceptance Criteria

### GitHub Client

- [ ] Given valid `GitHubClientConfig` values, when `createGitHubClient` is called, then it returns an object satisfying the `GitHubClient` interface with no type assertions in the adapter implementation.
- [ ] Given `createGitHubClient` is called with valid config, when the Octokit instance is constructed, then it uses `createAppAuth` as the auth strategy with the provided `appID`, `privateKey`, and `installationID`.
- [ ] Given the returned `GitHubClient`, when any method is called (e.g., `issues.listForRepo`), then it delegates to the corresponding Octokit method and returns the result with correct types.
- [ ] Given the returned `GitHubClient`, when any method is called, then all parameters are forwarded to Octokit without transformation and all Octokit errors propagate to the caller without modification.
- [ ] Given the engine codebase, when inspected, then no file outside `engine/github-client/` imports from `@octokit/rest` or `@octokit/auth-app`.

### Pollers

See `control-plane-engine-pollers.md` for all poller acceptance criteria.

### Dispatch

- [ ] Given the SpecPoller returns N changed files, when the Engine Core processes the batch, then N individual `specChanged` events are emitted (one per file).
- [ ] Given a spec's frontmatter status is `approved` and its blob SHA changed, when the Engine Core emits `specChanged`, then the Planner is auto-dispatched with that spec path.
- [ ] Given a spec's frontmatter status is `draft` and its blob SHA changed, when the Engine Core emits `specChanged`, then the Planner is not dispatched for that spec.
- [ ] Given multiple approved specs changed in the same SpecPoller cycle, when the Planner is dispatched, then it receives all changed spec paths in a single invocation.
- [ ] Given an issue status changed to `status:review`, when the IssuePoller emits the change, then the Reviewer is auto-dispatched for that issue.
- [ ] Given an issue is `status:pending`, when the change is first detected, then a `dispatchReady` event is emitted.
- [ ] Given an issue status changes to `status:unblocked` or `status:needs-changes`, when the IssuePoller emits the change, then a `dispatchReady` event is emitted.
- [ ] Given the `dispatchReviewer` command is received for issue N, when no agent is running for issue N, then a Reviewer session is created.
- [ ] Given the `dispatchReviewer` command is received for an issue not in the IssuePoller snapshot, when the command is processed, then it is a no-op.
- [ ] Given an issue status changes to `status:needs-refinement`, when the IssuePoller emits the change, then a `notification` event is emitted with a clipboard-ready CLI command, the issue URL as `contextURL`, and resolution guidance.
- [ ] Given an issue status changes to `status:blocked`, when the IssuePoller emits the change, then a `notification` event is emitted with the issue URL as `contextURL` and resolution guidance.
- [ ] Given an issue status changes to `status:approved`, when the IssuePoller emits the change, then a `notification` event is emitted with the issue URL as initial `contextURL` (async PR URL update by TUI).
- [ ] Given a notification was emitted for an issue, when the issue's status changes on a subsequent poll, then `notificationDismissed` is emitted.

### Agent Lifecycle

See `control-plane-engine-agent-manager.md` for all agent lifecycle, definition loading, programmatic hooks, SDK session configuration, and stream accessor acceptance criteria.

### Recovery

See `control-plane-engine-recovery.md` for all recovery acceptance criteria.

### Planner Cache

See `control-plane-engine-planner-cache.md` for all planner cache acceptance criteria.

### Queries and Streams

- [ ] Given `getIssueDetails` is called with an issue number, when the issue exists, then it returns the issue body, labels, and creation date.
- [ ] Given `getIssueDetails` is called for an issue with a `null` body, when the result is returned, then `body` is an empty string.
- [ ] Given `getIssueDetails` is called for an issue with labels in mixed format (bare strings and `{ name }` objects), when the result is returned, then `labels` contains extracted name strings from both formats.
- [ ] Given `getPRForIssue` is called with an issue number, when a linked PR exists (via closing keyword body match), then it returns the PR number, title, changed files count, CI status, and URL.
- [ ] Given `getPRForIssue` finds a linked PR, when all check runs have `conclusion: 'success'` and combined status is `'success'`, then `ciStatus` is `'success'`.
- [ ] Given `getPRForIssue` finds a linked PR, when any check run has `conclusion: 'failure'`, `'cancelled'`, or `'timed_out'`, then `ciStatus` is `'failure'`.
- [ ] Given `getPRForIssue` finds a linked PR, when any check run has `status` other than `'completed'`, then `ciStatus` is `'pending'`.
- [ ] Given `getPRForIssue` is called with an issue number, when no linked PR exists, then it returns `null`.
Stream accessor (`getAgentStream`) acceptance criteria are in `control-plane-engine-agent-manager.md`.

### Agent Session Logging

See `control-plane-engine-agent-manager.md` § Agent Session Logging for all agent session logging acceptance criteria.

### Operational

- [ ] Given the `shutdown` command is received, when running agents exist, then the engine waits up to `shutdownTimeout` seconds before cancelling them.
- [ ] Given a GitHub API error occurs during a poll cycle, when the error is caught, then the affected poller logs it and retries next cycle without crashing.
- [ ] Given a config file is missing or invalid, when the engine starts, then it logs an error and exits immediately.
- [ ] Given the `cancelAgent` command is received for issue N, when an agent is running for it, then the session is cancelled, `agentFailed` is emitted, and crash recovery runs if applicable (Implementor with `status:in-progress` only).
- [ ] Given the `cancelAgent` command is received for issue N, when no agent is running for it, then the command is a no-op.
- [ ] Given an agent session has been running longer than `maxAgentDuration`, when the timer fires, then the session is cancelled and failure handling runs (including crash recovery if the issue is still `status:in-progress`).
- [ ] Given the `cancelPlanner` command is received, when a Planner is running, then the Planner session is cancelled and `agentFailed` is emitted with a cancellation error.
- [ ] Given the `cancelPlanner` command is received, when no Planner is running, then the command is a no-op.
- [ ] Given a Planner is already running, when the SpecPoller detects new changes, then `agentSkipped` is emitted and the changes are deferred to the next cycle.
- [ ] Given changes were deferred from a previous SpecPoller cycle, when the next cycle runs and the Planner is no longer running, then the deferred paths are merged with the new cycle's results and dispatched together.
- [ ] Given deferred spec paths include a path whose frontmatter status changed to non-approved since deferral, when the merged set is dispatched, then the non-approved path is dropped from the batch.
- [ ] Given an issue was present in the previous poll but is absent from the current poll results, when the Engine Core processes the removal, then `issueRemoved` is emitted.
- [ ] Given an agent is running for issue N, when issue N is removed from the poll results (closed or label removed), then the agent session is cancelled, `agentFailed` is emitted before `issueRemoved`.
- [ ] Given an issue status changes to a user-dispatch status, when the Engine Core processes the change, then `issueStatusChanged` is emitted before `dispatchReady`.
- [ ] Given a Planner session fails, when the failure is detected, then the dispatched spec paths are re-added to the deferred buffer for the next dispatch attempt.
- [ ] Given recovery resets an issue to `status:pending`, when the recovery completes, then both `recoveryPerformed` and a synthetic `issueStatusChanged` are emitted so the TUI updates immediately.

### Repository Root

- [ ] Given `createEngine` is called without an explicit `repoRoot` dependency, when the engine initializes, then it resolves the repository root via `git rev-parse --show-toplevel`.
- [ ] Given `createEngine` is called with an explicit `repoRoot` dependency, when the engine initializes, then it uses the provided value without running `git rev-parse`.
- [ ] Given the resolved `repoRoot`, when worktrees are created, then they are located at `{repoRoot}/.worktrees/issue-<N>`.
- [ ] Given the resolved `repoRoot`, when the `QueryFactory` loads agent definitions, then it reads from `{repoRoot}/.claude/agents/<name>.md`.
- [ ] Given the agent definition file does not exist at the expected path or contains malformed YAML, when the engine attempts to dispatch the agent, then the dispatch fails with an error (treated as agent session creation failure).
- [ ] Given `git rev-parse --show-toplevel` fails (not inside a git repository), when the engine initializes, then it logs an error and exits.

## Dependencies

- `@octokit/rest` — GitHub REST API client. Wrapped by the `GitHubClient` adapter; not imported directly outside `engine/github-client/`.
- `@octokit/auth-app` — GitHub App authentication strategy for `@octokit/rest`. Handles JWT creation, installation token exchange, and automatic token refresh.
- `@anthropic-ai/claude-agent-sdk` (≥0.2.x) — The v1 `query()` API is used for all agent invocations. Agent definitions are loaded inline by the engine (see `control-plane-engine-agent-manager.md` § Agent Definition Loading) and passed via the `agents` option. The bash validator hook is passed via the `hooks` option (see `control-plane-engine-agent-manager.md` § Programmatic Hooks). `settingSources: ['project']` loads project-level settings (CLAUDE.md, `.claude/settings.json`, skills). See `control-plane-engine-agent-manager.md` § SDK Session Configuration for the full call signature and option details.
- `gray-matter` — YAML frontmatter parser. Used by the `QueryFactory` to parse agent definition files (`.claude/agents/<name>.md`) into structured frontmatter + markdown body. Imported only in `engine/agent-manager/`.
- `agent-hook-bash-validator.md` — Normative validation rules for the Bash tool hook (blocklist, allowlist, segmentation). The engine provides a TypeScript implementation; see `control-plane-engine-agent-manager.md` § Programmatic Hooks.
- `control-plane-engine-pollers.md` — IssuePoller and SpecPoller sub-spec
- `control-plane-engine-agent-manager.md` — Agent Manager sub-spec (lifecycle, SDK sessions, definition loading, hooks, streams, logging)
- `control-plane-engine-recovery.md` — Recovery sub-spec (startup and crash recovery)
- `control-plane-engine-planner-cache.md` — Planner Cache sub-spec
- `control-plane.md` — Parent architecture spec (dispatch tiers, worktree isolation, recovery policy)
- `workflow.md` — Status transition table, quality gates, escalation protocol
- `agent-planner.md` — Planner agent definition (invoked by auto-dispatch)
- `agent-implementor.md` — Implementor agent definition (invoked by user-dispatch)
- `agent-reviewer.md` — Reviewer agent definition (invoked by auto-dispatch)

## References

- `control-plane-engine-pollers.md` — Poller behavior, snapshot state, change detection, type definitions
- `control-plane-engine-agent-manager.md` — Agent lifecycle, SDK session configuration, stream accessor, session logging
- `control-plane-engine-recovery.md` — Startup and crash recovery behavior
- `control-plane-engine-planner-cache.md` — Planner cache format, seeding, write behavior
- `control-plane-tui.md` — TUI specification (consumes the engine's four interfaces: events, commands, queries, streams)
