---
title: Control Plane Engine
version: 0.15.0
last_updated: 2026-02-12
status: approved
---

# Control Plane Engine

## Overview

The engine is the core module of the control plane. It orchestrates independent pollers that monitor
GitHub for state changes, classifies detected changes into dispatch tiers, manages agent sessions,
and handles recovery. The engine has no knowledge of the TUI — it exposes four interfaces (event
emitter, command interface, query interface, and stream accessor) that the TUI (or any other
consumer) can use.

## Constraints

- Must not import or reference the TUI module.
- Must not crash on transient errors (GitHub API failures, network errors). Log and retry next
  cycle.
- Must not dispatch more than one agent per task issue at a time.
- Must not auto-dispatch the Planner for specs without `status: approved` in frontmatter.
- Must reset `status:in-progress` issues to `status:pending` when no agent is running for them
  (startup recovery and crash recovery).
- Must use `@octokit/rest` with `@octokit/auth-app` as the authentication strategy for all GitHub
  API interactions. Octokit is an implementation detail of the GitHub Client adapter — all engine
  code interacts with the `GitHubClient` interface, never with Octokit directly. No type assertions
  (`as`) are permitted at the adapter boundary or anywhere `GitHubClient` is consumed.
- Must use `@anthropic-ai/claude-agent-sdk` (≥0.2.x) for all agent invocations via the v1 `query()`
  API.
- Must detect spec changes remotely (via GitHub API), not from the local filesystem.
- GitHub write operations are limited to recovery (status label resets) and completion-dispatch
  (setting `status:review`). All other writes are performed by agents.

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
    QI -- "getIssueDetails / getPRForIssue\ngetPRFiles / getPRReviews" --> Core
```

- **Pollers** — Independent units that each monitor a single data source on their own interval.
  Pollers are pure sensors — they detect state changes and report results. IssuePoller emits events
  directly; SpecPoller returns batched results to the Engine Core. They do not make dispatch
  decisions.
- **Engine Core** — Receives poller events, classifies them by dispatch tier, and manages agent
  sessions. Owns dispatch policy and agent lifecycle. Engine Core sub-components are specified in
  dedicated sub-specs: Agent Manager
  ([control-plane-engine-agent-manager.md](./control-plane-engine-agent-manager.md)), Recovery
  ([control-plane-engine-recovery.md](./control-plane-engine-recovery.md)), Planner Cache
  ([control-plane-engine-planner-cache.md](./control-plane-engine-planner-cache.md)).
- **Interfaces** — Event emitter (outbound state changes), command interface (inbound user actions),
  query interface (on-demand data fetching), and stream accessor (live agent output). All consumed
  by the TUI.

Each poller maintains its own snapshot slice. A failure in one poller does not affect others.

### GitHub Client

The engine accesses GitHub through a `GitHubClient` interface — a narrow, explicitly-typed contract
covering only the API methods the engine uses. The `createGitHubClient` factory constructs an
Octokit instance internally and returns a thin adapter that satisfies `GitHubClient` without type
assertions.

> **Rationale:** Octokit's deeply generic types do not structurally match a narrow interface, even
> when the methods are compatible at runtime. Casting (`as unknown as GitHubClient`) would hide real
> mismatches. Instead, each adapter method explicitly calls the corresponding Octokit method and
> returns the result through a properly-typed function signature. The wrappers are 1:1 delegations —
> no transformation, no error mapping, no retry logic. They exist solely to bridge the type gap.

**Factory:** `createGitHubClient(config: GitHubClientConfig): GitHubClient`

The factory:

1. Creates an `Octokit` instance with `createAppAuth` as the auth strategy, using the provided
   `appID`, `privateKey`, and `installationID`.
2. Returns an object satisfying `GitHubClient` where each method delegates to the corresponding
   Octokit method.

**Module location:** `engine/github-client/`. The module contains:

- `types.ts` — `GitHubClientConfig`, `GitHubClient`, and all param/result types.
- `create-github-client.ts` — The adapter factory. Imports `Octokit` from `@octokit/rest` and
  `createAppAuth` from `@octokit/auth-app`. This is the only file in the engine that imports from
  `@octokit/*`.

**Octokit isolation:** No file outside `engine/github-client/` may import from `@octokit/rest` or
`@octokit/auth-app`.

> **Rationale:** This ensures Octokit is a swappable implementation detail.

**Caller responsibility:** The caller reads the private key from disk and passes the PEM content as
a string. The adapter does not perform filesystem I/O.

**Auth validation:** `@octokit/auth-app` validates credentials lazily — the first API call triggers
JWT creation and token exchange, not the `createGitHubClient` call itself. If credentials are
invalid (bad key, wrong app ID, etc.), the first poller cycle will fail. The engine's error handling
(log and retry next cycle) applies, but since invalid credentials never self-heal, this will fail
indefinitely (see [Known Limitations](#known-limitations)).

> **Rationale:** This is acceptable for v1 — invalid credentials are a deployment misconfiguration,
> caught immediately on first cycle. The operator must fix the config and restart.

### Pollers

The engine uses two independent pollers: the **IssuePoller** monitors GitHub Issues for `status:*`
label changes, and the **SpecPoller** monitors the specs directory on the default branch for file
changes via the GitHub Trees API. Each runs on its own interval and maintains its own snapshot. See
[control-plane-engine-pollers.md](./control-plane-engine-pollers.md) for full poll cycle behavior,
snapshot state, change detection, closed issue detection, startup burst, first-cycle execution,
snapshot seeding, and type definitions.

### Dispatch Logic

The engine core listens to poller events and classifies each into a dispatch tier. Dispatch logic is
centralized — pollers never dispatch agents.

#### Auto-dispatch

The engine invokes the agent automatically with no user action.

| Poller Event  | Agent   | Condition                               |
| ------------- | ------- | --------------------------------------- |
| `specChanged` | Planner | Spec frontmatter `status` is `approved` |

The Planner is invoked once per SpecPoller cycle with all changed (and approved) spec paths batched
into a single invocation. The Engine Core receives the full batch from the SpecPoller synchronously
and passes approved paths to a single Planner dispatch. Before dispatching, the Engine Core builds
an enriched trigger prompt containing the full content of each changed spec, existing open task
issues, and commit SHAs for diff support. See
[control-plane-engine-agent-manager.md: Planner Context Pre-computation](./control-plane-engine-agent-manager.md#planner-context-pre-computation)
for the prompt format and data sources.

**Planner concurrency guard:** Only one Planner session may run at a time. If a SpecPoller cycle
detects changes while a Planner is already running, the engine emits `agentSkipped` for the Planner
and defers the batch. The Engine Core maintains a deferred paths buffer (a set of file paths,
deduplicated) for this purpose. On each subsequent SpecPoller cycle, the Engine Core merges the
deferred buffer with the new cycle's results (union, deduplicated). The approval filter
(`status: approved`) is applied to the merged set at dispatch time — paths whose frontmatter status
changed to non-approved since deferral are dropped. The deferred buffer is cleared when the Planner
is successfully dispatched. If the Planner session fails, the Engine Core re-adds the dispatched
spec paths to the deferred buffer so they are included in the next dispatch attempt rather than
being lost until restart.

**Planner idempotency:** The engine does not prevent re-dispatch for the same spec (e.g., a
whitespace-only change to an approved spec will re-trigger the Planner). The Planner agent
definition is responsible for idempotency — checking existing issues before creating new ones. See
`agent-planner.md`.

#### Completion-dispatch

The Reviewer is dispatched when an Implementor agent session completes, not when a status label
changes.

> **Rationale:** This eliminates the race condition where a `status:review` label is set before the
> PR exists.

**Trigger:** When the Agent Manager reports an Implementor `agentCompleted` event, the Engine Core:

1. Calls `getPRForIssue(issueNumber, { includeDrafts: false })` to check for a linked non-draft PR.
2. **PR found:** Sets `status:review` on the issue (via `GitHubClient`), updates the IssuePoller
   snapshot entry to `status:review` (via `updateEntry()`) to prevent a duplicate
   `issueStatusChanged` on the next poll cycle, emits a synthetic `issueStatusChanged` event (with
   `isEngineTransition: true`), builds an enriched Reviewer trigger prompt (see
   [control-plane-engine-agent-manager.md: Reviewer Context Pre-computation](./control-plane-engine-agent-manager.md#reviewer-context-pre-computation)),
   and dispatches the Reviewer.
3. **No PR found:** Takes no action. The issue remains `status:in-progress`. Crash recovery detects
   this (no running agent + `status:in-progress`) and resets to `status:pending`.

This flow also handles re-reviews after `needs-changes`: the Implementor is re-dispatched, pushes
fixes to the existing PR, and completes. The engine finds the existing non-draft PR and dispatches
the Reviewer.

**`status:review` is not a dispatch trigger.** The IssuePoller tracks `status:review` for TUI
display, but it does not trigger Reviewer dispatch. If `status:review` is set externally (e.g.,
manual label change), no Reviewer is dispatched. The user can manually dispatch a Reviewer via the
TUI's retry mechanism if needed.

**Implementor failure:** When the Agent Manager reports an Implementor `agentFailed` event, no PR
check or Reviewer dispatch occurs. Crash recovery handles the issue status.

The Reviewer is invoked per issue — one Reviewer per issue where the Implementor completed with a
linked PR.

#### User-dispatch

The engine emits a `dispatchReady` event surfacing the issue to the TUI. The user decides when (or
whether) to dispatch.

| Poller Event                                   | Agent       |
| ---------------------------------------------- | ----------- |
| `issueStatusChanged` to `status:pending`       | Implementor |
| `issueStatusChanged` to `status:unblocked`     | Implementor |
| `issueStatusChanged` to `status:needs-changes` | Implementor |

User-dispatch items are surfaced on first detection (status differs from snapshot). They are not
re-surfaced on subsequent polls if the status has not changed again.

#### Notify-only

The engine emits a notification event. No agent is dispatched.

| Poller Event                                      | Notification                                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issueStatusChanged` to `status:needs-refinement` | Clipboard-ready CLI command for the Human to address the spec issue. Includes resolution guidance: "After amending the spec, change the label to `status:unblocked`." `contextURL`: issue URL.      |
| `issueStatusChanged` to `status:blocked`          | Notification with issue URL for the Human to investigate the blocker. Includes resolution guidance: "After resolving the blocker, change the label to `status:unblocked`." `contextURL`: issue URL. |
| `issueStatusChanged` to `status:approved`         | Notification that the issue is ready for Human to merge. `contextURL`: issue URL. The TUI is responsible for asynchronous PR URL lookup (see `control-plane-tui.md`).                               |

**Clipboard command format** for `status:needs-refinement`:

```
claude -p "Use /spec-writing to address the spec refinement needed for issue #<N>. See blocker comment: https://github.com/<owner>/<repo>/issues/<N>"
```

> **Rationale:** This gives the Human a ready-to-paste command to kick off a spec amendment workflow
> outside the control plane. The `/spec-writing` skill handles the structured spec authoring
> process.

Notifications are dismissed automatically when the underlying issue's status changes to a different
value on a subsequent poll.

**Event ordering:** For each status change, the Engine Core emits `issueStatusChanged` before any
dispatch-tier event (`dispatchReady`, `notification`, or auto-dispatch trigger).

> **Rationale:** This ensures the TUI's store has the updated issue state before processing dispatch
> events that reference it.

**Dispatch fallthrough:** Status changes to values not listed in any dispatch tier (e.g.,
`in-progress`, `review`) trigger no dispatch action. The `issueStatusChanged` event is still emitted
so the TUI can update the issue's state indicator.

> **Rationale:** `status:review` falls through because Reviewer dispatch is completion-driven (see
> [Completion-dispatch](#completion-dispatch)), not label-driven.

**Removed issue orchestration:** When the IssuePoller reports that an issue has been removed (closed
or `task:implement` label removed), the Engine Core handles the response: (1) if an agent is running
for the issue, cancel the agent session and emit `agentFailed` (treated as cancellation — worktree
cleaned up, branch preserved); then (2) emit `issueRemoved`. This ordering guarantees `agentFailed`
is emitted before `issueRemoved` for the same issue.

> **Rationale:** This ordering lets the TUI process the failure before the issue is removed from its
> store.

### Event Emitter

The engine emits typed events for discrete state changes. Events drive reactive updates in the TUI's
Zustand store. Streaming agent output is handled separately via the stream accessor (see below).

| Event                   | Payload                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Emitted By                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `issueStatusChanged`    | Issue number, title, old status, new status, priority label, creation date, `isRecovery` flag (true for synthetic events from recovery), `isEngineTransition` flag (true only for the synthetic event from completion-dispatch — when the engine sets `status:review` on Implementor completion)                                                                                                                                                                                 | IssuePoller (or Engine Core for synthetic events: recovery, completion-dispatch) |
| `specChanged`           | File path, frontmatter status, change type (added/modified), commit SHA                                                                                                                                                                                                                                                                                                                                                                                                          | Engine Core (from SpecPoller results)                                            |
| `agentStarted`          | Agent type, issue number or spec paths, session ID                                                                                                                                                                                                                                                                                                                                                                                                                               | Agent Manager                                                                    |
| `agentCompleted`        | Agent type, issue number or spec paths, session ID, log file path (when logging enabled)                                                                                                                                                                                                                                                                                                                                                                                         | Agent Manager                                                                    |
| `agentFailed`           | Agent type, issue number or spec paths, error details, session ID, branch name (Implementor and Reviewer — the branch persists after worktree cleanup for inspection), log file path (when logging enabled)                                                                                                                                                                                                                                                                      | Agent Manager                                                                    |
| `agentSkipped`          | Agent type, issue number or spec paths (deferred)                                                                                                                                                                                                                                                                                                                                                                                                                                | Agent Manager (per-issue guard) or Engine Core (Planner concurrency guard)       |
| `dispatchReady`         | Issue number, status label                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Dispatch Logic                                                                   |
| `notification`          | Issue number, status label, `contextURL` (issue URL), `clipboardCommand` (optional — present for `needs-refinement`, absent for `blocked` and `approved`), `resolutionGuidance` (optional — present for `needs-refinement` and `blocked`, absent for `approved`). Note: this is a specific engine event type for notify-only tier issues, distinct from the TUI's "notification" concept (the TUI surfaces all engine events as notification entries in the notifications pane). | Dispatch Logic                                                                   |
| `notificationDismissed` | Issue number                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Dispatch Logic                                                                   |
| `issueRemoved`          | Issue number                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Engine Core (in response to IssuePoller reporting a removed issue)               |
| `recoveryPerformed`     | Issue number, old status, new status                                                                                                                                                                                                                                                                                                                                                                                                                                             | Engine Core (startup recovery and crash recovery)                                |

### Command Interface

The engine accepts commands that trigger side effects.

| Command               | Parameters   | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatchImplementor` | Issue number | Creates an Implementor agent session for the given issue (if no agent is already running for it). No-op if the issue number is not in the IssuePoller snapshot, or if an agent is already running for the issue. Accepted when the issue's status is in the user-dispatch set (`pending`, `unblocked`, `needs-changes`) or `in-progress` with no running agent (transient state before crash recovery resets it). Worktree strategy is selected based on whether a linked PR exists. See [control-plane.md: Worktree Isolation](./control-plane.md#worktree-isolation) for strategy overview and [control-plane-engine-agent-manager.md: Agent Lifecycle](./control-plane-engine-agent-manager.md#agent-lifecycle) for implementation. The Engine Core reads the issue's `complexity:*` label from the IssuePoller snapshot and passes a `modelOverride` to the `QueryFactory`: `complexity:simple` → `'sonnet'`, `complexity:complex` → `'opus'`. If no complexity label is present, no override is passed (the Implementor's agent definition default applies).                       |
| `dispatchReviewer`    | Issue number | Creates a Reviewer agent session for the given issue (if no agent is already running for it). No-op if the issue number is not in the IssuePoller snapshot, if the issue's status is not `review`, or if no linked open PR is found (the Reviewer requires a PR branch to check out). Before creating the session, the Engine Core calls `getPRForIssue(issueNumber, { includeDrafts: false })` to obtain the PR's `headRefName` for the worktree, then builds an enriched trigger prompt via `getIssueDetails`, `getPRFiles`, and `getPRReviews` (see [control-plane-engine-agent-manager.md: Reviewer Context Pre-computation](./control-plane-engine-agent-manager.md#reviewer-context-pre-computation)). The Agent Manager fetches the branch from the remote and creates a worktree at `origin/<headRefName>`. See [control-plane.md: Worktree Isolation](./control-plane.md#worktree-isolation). No transient-state exception is needed (unlike `dispatchImplementor`) — Reviewers do not change the issue status to `in-progress`. Used for manual retry after Reviewer failure. |
| `cancelAgent`         | Issue number | Cancels the running agent session for the given issue. The engine determines agent-specific behavior (recovery, worktree handling) from its internal tracking of which agent type is running. For Implementors: performs crash recovery if the issue is still `status:in-progress`, removes the worktree (branch preserved for inspection). For Reviewers: no recovery needed (issue stays `status:review`; user can retry via `dispatchReviewer`), removes the worktree (branch preserved for inspection). Emits `agentFailed` with a cancellation error. No-op if no agent is running.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `cancelPlanner`       | None         | Cancels the running Planner session if one exists. Emits `agentFailed` with a cancellation error. No-op if no Planner is running. Not exposed in the TUI (see [Known Limitations](#known-limitations)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `shutdown`            | None         | Initiates graceful shutdown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Query Interface

The engine provides on-demand data fetching for display purposes. Queries are read-only and fetch
data via `GitHubClient` when called. Results are not cached by the engine — the TUI manages its own
caching in the Zustand store.

| Query             | Parameters                                               | Returns                                                                                                                                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getIssueDetails` | Issue number                                             | Issue body (objective, spec reference, scope, acceptance criteria), labels, creation date                                                                                                                                                                                               |
| `getPRForIssue`   | Issue number, `includeDrafts` (boolean, default `false`) | PR number, title, changed files count, CI status, URL, `isDraft`, `headRefName`. Returns `null` if no linked PR exists. When `includeDrafts` is `false`, draft PRs are excluded from results. When `true`, draft PRs are included (used by the engine for worktree strategy selection). |
| `getPRFiles`      | PR number                                                | Array of changed files with filename, status (added/modified/removed/renamed/copied/changed/unchanged), and patch (unified diff per file). Returns empty array if the PR has no changed files.                                                                                          |
| `getPRReviews`    | PR number                                                | Review submissions (id, author, state, body) and inline comments (id, author, body, path, line) in separate arrays. Returns empty arrays if no reviews exist.                                                                                                                           |

PR linkage is determined by searching for a PR whose body contains a closing keyword referencing the
issue number. The match is case-insensitive and supports GitHub's closing keywords: `Closes`,
`Fixes`, `Resolves` (and their conjugations: `Close`, `Closed`, `Fix`, `Fixed`, `Resolve`,
`Resolved`). The issue number must be followed by whitespace, punctuation, or end of line — not
additional digits (word-boundary match). If multiple open PRs match, the first match (by PR number,
ascending) is used.

**Pagination:** `getIssueDetails` fetches the issue directly via `issues.get` (no pagination
concern). `getPRForIssue` lists open PRs via `pulls.list` with `per_page: 100` without pagination.
`getPRFiles` calls `pulls.listFiles` with `per_page: 100` without pagination (GitHub hard limit:
3000 files per PR). `getPRReviews` calls `pulls.listReviews` and `pulls.listReviewComments`, both
with `per_page: 100` without pagination. The IssuePoller's `issues.listForRepo` call also uses
`per_page: 100` without pagination. Results are silently truncated beyond 100 items per call (see
[Known Limitations](#known-limitations)).

**Query normalization:** The `GitHubClient` param/result types mirror Octokit's response shapes
(e.g., `IssueData.body` is `string | null`, `IssueData.labels` is `(string | { name?: string })[]`).
The query functions normalize these into the cleaner result types consumed by the TUI:

- `getIssueDetails` — Coerces `body` from `string | null` to `string` (empty string for `null`).
  Extracts label names from the `labels` array: for each entry, uses the string directly if it is a
  bare string, or extracts the `name` property if it is an object with a `name` string. Entries that
  are objects without a `name` property are discarded.
- `getPRForIssue` — Lists open PRs (`per_page: 100`), finds the one whose body matches a closing
  keyword for `#<N>`, then fetches the full PR via `pulls.get` to obtain `head.sha`. Uses `head.sha`
  to query CI status via `repos.getCombinedStatusForRef` and `checks.listForRef`. Combines both into
  the `ciStatus` field using the following logic:
  - `'failure'` — if `getCombinedStatusForRef` reports `state: 'failure'`, or any check run has
    `conclusion` of `'failure'`, `'cancelled'`, or `'timed_out'`.
  - `'pending'` — if any check run has `status` other than `'completed'` (i.e., `'queued'` or
    `'in_progress'`), or if `getCombinedStatusForRef` reports `state: 'pending'`, or if both
    endpoints report `total_count: 0` (no CI configured).
  - `'success'` — if `getCombinedStatusForRef` reports `state: 'success'` (or `total_count: 0`) and
    all check runs have `status: 'completed'` with `conclusion: 'success'`.
- `getPRFiles` — Calls `pulls.listFiles({ owner, repo, pull_number, per_page: 100 })`. Each entry is
  normalized to `{ filename, status, patch }`. The `patch` field is `string | undefined` — GitHub
  omits it for binary files and files exceeding the diff size limit. Entries with no `patch` are
  included (the Reviewer sees the filename and status, but no diff content).
- `getPRReviews` — Calls `pulls.listReviews` and `pulls.listReviewComments` (both `per_page: 100`).
  Reviews are normalized to `{ id, author, state, body }` where `author` is extracted from
  `user.login` (empty string if absent) and `body` is coerced from `string | null` to `string`.
  Inline comments are normalized to `{ id, author, body, path, line }`. Reviews and comments are
  returned in separate arrays in API order (chronological).

### Agent Manager

The Agent Manager handles agent session lifecycle — creating sessions via the Claude Agent SDK,
tracking active sessions, monitoring completion, managing worktrees, exposing live agent output
streams, and handling session logging. See
[control-plane-engine-agent-manager.md](./control-plane-engine-agent-manager.md) for agent lifecycle
steps, agent definition loading, programmatic hooks (bash validator), SDK session configuration,
stream accessor, agent session logging, and related type definitions. The `AgentManagerConfig` type
(defined in the sub-spec) carries `repoRoot`, `maxAgentDuration`, and logging settings derived from
`EngineConfig`.

### Recovery

The engine performs recovery to ensure no issue is permanently stuck in `status:in-progress`.
Recovery resets stale issues to `status:pending` and emits synthetic events. See
[control-plane-engine-recovery.md](./control-plane-engine-recovery.md) for startup recovery, crash
recovery, and Reviewer failure behavior.

### Planner Cache

The engine persists a lightweight cache to prevent redundant Planner runs across restarts. See
[control-plane-engine-planner-cache.md](./control-plane-engine-planner-cache.md) for cache format,
startup seeding, cache write behavior, deferred paths interaction, and error handling.

### Repository Root Resolution

The engine must resolve the git repository root at startup. This path is used for:

- Worktree creation (`.worktrees/<branchName>` is relative to repo root)
- Agent definition loading (`.claude/agents/<name>.md` is read from repo root)
- Planner cache file location (`.agentic-workflow-cache.json` at repo root)
- Relative `logsDir` resolution

**Resolution:** The `createEngine` factory resolves the repository root using
`git rev-parse --show-toplevel` (via `execFileSync`). This is a synchronous call that runs once at
engine construction time.

> **Rationale:** `process.cwd()` is not used because in a Yarn workspace it resolves to the package
> directory (e.g., `agentic-workflow/`), not the repository root. Using it would create worktrees
> inside the package directory and fail to find `.claude/agents/` for agent definition loading.

**Override:** The `createEngine` factory accepts an optional `repoRoot` dependency injection for
testing. When not provided, it uses `git rev-parse --show-toplevel`.

### Configuration

The engine reads configuration from a TypeScript config file (`agentic-workflow.config.ts`):

#### Engine

| Setting                   | Type     | Description                                  | Default  |
| ------------------------- | -------- | -------------------------------------------- | -------- |
| `repository`              | `string` | GitHub repository in `owner/repo` format     | Required |
| `githubAppID`             | `number` | GitHub App numeric ID                        | Required |
| `githubAppPrivateKeyPath` | `string` | Path to the PEM private key file             | Required |
| `githubAppInstallationID` | `number` | Installation ID for the target repository    | Required |
| `logLevel`                | `string` | Logging verbosity (`debug`, `info`, `error`) | `info`   |
| `shutdownTimeout`         | `number` | Seconds to wait for agents during shutdown   | `300`    |

At startup, the engine parses `repository` into `owner` and `repo` strings (split on `/`). It reads
the private key file from `githubAppPrivateKeyPath` and passes the PEM content string to
`createGitHubClient` along with `githubAppID` and `githubAppInstallationID`. The returned
`GitHubClient` instance, along with `owner` and `repo`, is then passed to all pollers, queries, and
recovery as dependencies. Authentication is handled internally by `@octokit/auth-app` (JWT creation,
installation token exchange, automatic token refresh) — no manual token management is needed. The
App must have `issues:write` (for recovery label resets) and `contents:read` (for tree/file access)
permissions.

#### IssuePoller

| Setting        | Type     | Description                 | Default |
| -------------- | -------- | --------------------------- | ------- |
| `pollInterval` | `number` | Seconds between poll cycles | `30`    |

#### SpecPoller

| Setting         | Type     | Description                                         | Default       |
| --------------- | -------- | --------------------------------------------------- | ------------- |
| `pollInterval`  | `number` | Seconds between poll cycles                         | `60`          |
| `specsDir`      | `string` | Path to the specs directory (relative to repo root) | `docs/specs/` |
| `defaultBranch` | `string` | Branch to monitor for spec changes                  | `main`        |

#### Agents

| Setting            | Type     | Description                                                                                                                                                             | Default         |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `agentPlanner`     | `string` | Agent name for the Planner. The engine reads `.claude/agents/<name>.md` from the repository root, parses it, and passes the definition inline to the SDK.               | `'planner'`     |
| `agentImplementor` | `string` | Agent name for the Implementor. The engine reads `.claude/agents/<name>.md` from the repository root, parses it, and passes the definition inline to the SDK.           | `'implementor'` |
| `agentReviewer`    | `string` | Agent name for the Reviewer. The engine reads `.claude/agents/<name>.md` from the repository root, parses it, and passes the definition inline to the SDK.              | `'reviewer'`    |
| `maxAgentDuration` | `number` | Maximum seconds an agent session can run before being cancelled. Applies to all agent types. When exceeded, the engine cancels the session and performs crash recovery. | `1800` (30 min) |

#### Logging

| Setting         | Type      | Description                                                                                                                                                                                     | Default |
| --------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `agentSessions` | `boolean` | Enable writing agent session transcripts to disk. When enabled, the Agent Manager writes one log file per agent session capturing the full SDK message stream.                                  | `false` |
| `logsDir`       | `string`  | Directory for agent session log files. Absolute paths are used as-is. Relative paths are resolved from `repoRoot` (see Repository Root Resolution). Created automatically if it does not exist. | `logs`  |

When `agentSessions` is `false` (default), no log files are created and agent events do not include
`logFilePath`. The `logsDir` setting is ignored when `agentSessions` is disabled.

### Logging

The engine logs structured events at the following levels:

| Event                           | Level   | Content                                                                                                                                                     |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup                         | `info`  | Configuration summary, initial state counts                                                                                                                 |
| Poller cycle start              | `debug` | Poller name, cycle number                                                                                                                                   |
| Change detected                 | `info`  | Poller name, change type, issue number or file path                                                                                                         |
| Agent invoked                   | `info`  | Agent type, issue number or file path, session ID                                                                                                           |
| Agent skipped (already running) | `info`  | Agent type, issue number                                                                                                                                    |
| Agent completed                 | `info`  | Agent type, issue number                                                                                                                                    |
| Agent failed                    | `error` | Agent type, issue number, error details                                                                                                                     |
| No changes detected             | `debug` | Poller name, cycle number                                                                                                                                   |
| GitHub API error                | `error` | Poller name, error details                                                                                                                                  |
| Recovery performed              | `info`  | Issue number, old status, new status                                                                                                                        |
| Shutdown initiated              | `info`  | Reason                                                                                                                                                      |
| Shutdown complete               | `info`  | Agents terminated count                                                                                                                                     |
| Planner cache loaded            | `debug` | Loaded tree SHA and file count, or "cache miss — cold start"                                                                                                |
| Planner cache write failed      | `error` | Error details                                                                                                                                               |
| Agent session transcript        | (file)  | Full SDK message stream written to `{logsDir}/{timestamp}-{agentType}[-{context}].log`. One file per session. Only when `logging.agentSessions` is enabled. |

Entries with level `(file)` represent disk writes handled by the Agent Manager, not the structured
logger. See
[control-plane-engine-agent-manager.md: Agent Session Logging](./control-plane-engine-agent-manager.md#agent-session-logging)
for format details.

### Error Handling

The engine must not crash on transient errors. Each error type has a defined recovery behavior:

| Error                                                        | Behavior                                                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub API error (in any poller)                             | Log at `error` level. Skip this cycle for the affected poller only. Other pollers continue unaffected. Retry next cycle.                                                                                             |
| GitHub API rate limit (HTTP 403/429)                         | Treated as a GitHub API error — same log-and-skip behavior. The poll interval provides natural backoff (see [Known Limitations](#known-limitations)).                                                                |
| Agent definition file missing, unreadable, or malformed YAML | Treated as agent session creation failure — the error propagates before the session is created. Logged at `error` level. Not a transient error (requires fixing the agent file), but the engine continues operating. |
| Repository root resolution failure (`git rev-parse` fails)   | Log at `error` level and exit. The engine cannot operate without a valid repository root. This is a deployment misconfiguration (not running inside a git repository).                                               |
| Agent session creation failure                               | Log at `error` level. Do not mark agent as running. Next cycle will re-detect the state and retry dispatch.                                                                                                          |
| Agent session failure                                        | Log at `error` level with error details. Perform crash recovery if applicable.                                                                                                                                       |
| Config file missing or invalid                               | Log at `error` level and exit. This is not a transient error.                                                                                                                                                        |
| Planner cache read error                                     | Log at `debug` level. Treat as cold start — SpecPoller starts with empty snapshot. Non-fatal.                                                                                                                        |
| Planner cache write error                                    | Log at `error` level. Engine continues — next restart cannot skip Planner. Non-fatal.                                                                                                                                |

### Graceful Shutdown

When a shutdown command is received:

1. Log shutdown initiation.
2. Stop all pollers (no new cycles).
3. Wait for all running agent sessions to complete, up to `shutdownTimeout` seconds.
4. If timeout is reached, cancel remaining agent sessions (using `cancelAgent` for task agents and
   `cancelPlanner` for the Planner internally).
5. Log shutdown completion and exit.

### Type Definitions

Reference types for the engine's public interfaces. These define the contracts that the TUI (or any
consumer) relies on.

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
    listFiles(params: PullsListFilesParams): Promise<PullsListFilesResult>;
    listReviews(params: PullsListReviewsParams): Promise<PullsListReviewsResult>;
    listReviewComments(
      params: PullsListReviewCommentsParams,
    ): Promise<PullsListReviewCommentsResult>;
  };
  repos: {
    getCombinedStatusForRef(
      params: ReposGetCombinedStatusParams,
    ): Promise<ReposGetCombinedStatusResult>;
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
  type: "issueStatusChanged";
  issueNumber: number;
  title: string;
  oldStatus: string | null; // null on first detection
  newStatus: string;
  priorityLabel: string;
  createdAt: string; // ISO 8601
  isRecovery?: boolean; // true when emitted as synthetic event from crash recovery
  isEngineTransition?: boolean; // true when emitted as the synthetic event from completion-dispatch (engine sets status:review on Implementor completion)
  // isRecovery and isEngineTransition are mutually exclusive — at most one is true on any given event.
};

type SpecChangedEvent = {
  type: "specChanged";
  filePath: string;
  frontmatterStatus: string;
  changeType: "added" | "modified";
  commitSHA: string; // Always non-empty — events are only emitted when changes are detected. HEAD commit on default branch (for diff URLs).
};

type AgentType = "planner" | "implementor" | "reviewer";

type AgentStartedEvent = {
  type: "agentStarted";
  agentType: AgentType;
  issueNumber?: number; // present for Implementor, Reviewer
  specPaths?: string[]; // guaranteed present when agentType is 'planner'
  sessionID: string;
};

type AgentCompletedEvent = {
  type: "agentCompleted";
  agentType: AgentType;
  issueNumber?: number;
  specPaths?: string[];
  sessionID: string;
  logFilePath?: string; // present when logging.agentSessions is enabled
};

type AgentFailedEvent = {
  type: "agentFailed";
  agentType: AgentType;
  issueNumber?: number;
  specPaths?: string[];
  error: string;
  sessionID: string;
  branchName?: string; // present for Implementor and Reviewer — the branch persists after worktree cleanup for inspection
  logFilePath?: string; // present when logging.agentSessions is enabled
};

type AgentSkippedEvent = {
  type: "agentSkipped";
  agentType: AgentType;
  issueNumber?: number; // present for Implementor, Reviewer
  specPaths?: string[]; // present for Planner (deferred paths)
};

type DispatchReadyEvent = {
  type: "dispatchReady";
  issueNumber: number;
  statusLabel: string;
};

type NotificationEvent = {
  type: "notification";
  issueNumber: number;
  statusLabel: string;
  clipboardCommand?: string; // present for needs-refinement, absent for blocked and approved
  contextURL: string; // issue URL for all notification statuses (needs-refinement, blocked, approved)
  resolutionGuidance?: string; // The engine guarantees this is always present when statusLabel is 'needs-refinement' or 'blocked'; absent only for 'approved'.
  // blocked: "After resolving the blocker, change the label to status:unblocked."
  // needs-refinement: "After amending the spec, change the label to status:unblocked."
};

type NotificationDismissedEvent = {
  type: "notificationDismissed";
  issueNumber: number;
};

type IssueRemovedEvent = {
  type: "issueRemoved";
  issueNumber: number;
};

type RecoveryPerformedEvent = {
  type: "recoveryPerformed";
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
  command: "dispatchImplementor";
  issueNumber: number;
};

type DispatchReviewerCommand = {
  command: "dispatchReviewer";
  issueNumber: number;
};

type CancelAgentCommand = {
  command: "cancelAgent";
  issueNumber: number;
};

type CancelPlannerCommand = {
  command: "cancelPlanner";
};

type ShutdownCommand = {
  command: "shutdown";
};

type EngineCommand =
  | DispatchImplementorCommand
  | DispatchReviewerCommand
  | CancelAgentCommand
  | CancelPlannerCommand
  | ShutdownCommand;
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
  ciStatus: "pending" | "success" | "failure";
  url: string;
  isDraft: boolean;
  headRefName: string; // branch name — used by engine for worktree strategy (resume from PR branch)
} | null;

// Normalized from pulls.listFiles response:
// - patch: absent for binary files or files exceeding diff size limit
type PRFileEntry = {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  patch?: string;
};

// Normalized from pulls.listReviews + pulls.listReviewComments:
// - author: extracted from user.login (empty string if absent)
// - body: coerced from string | null to string (empty string for null)
type PRReview = {
  id: number;
  author: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body: string;
};

// - line: null for outdated comments where the line no longer exists
type PRInlineComment = {
  id: number;
  author: string;
  body: string;
  path: string;
  line: number | null;
};

type PRReviewsResult = {
  reviews: PRReview[];
  comments: PRInlineComment[];
};
```

#### Stream / Agent Manager

See
[control-plane-engine-agent-manager.md: Type Definitions](./control-plane-engine-agent-manager.md#type-definitions)
for `AgentStream`, `QueryFactoryParams`, `QueryFactory`, `QueryFactoryConfig`, `AgentManagerConfig`,
and `HookCallback`. See
[control-plane-engine-agent-manager.md: SDK Session Configuration](./control-plane-engine-agent-manager.md#sdk-session-configuration)
for `AgentDefinition`.

#### SpecPoller

See
[control-plane-engine-pollers.md: Type Definitions](./control-plane-engine-pollers.md#type-definitions)
for `SpecPollerFileEntry`, `SpecPollerSnapshot`, `SpecChange`, and `SpecPollerBatchResult`.

#### Configuration

```ts
type EngineConfig = {
  repository: string; // owner/repo format
  githubAppID: number;
  githubAppPrivateKeyPath: string;
  githubAppInstallationID: number;
  logLevel?: "debug" | "info" | "error"; // default: 'info'
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
  getPRForIssue(
    issueNumber: number,
    options?: { includeDrafts?: boolean },
  ): Promise<PRDetailsResult>;
  getPRFiles(prNumber: number): Promise<PRFileEntry[]>;
  getPRReviews(prNumber: number): Promise<PRReviewsResult>;
  getAgentStream(issueNumber: number): AgentStream;
};

// Startup contract: Callers MUST subscribe to the event emitter (via `on()`)
// before calling `start()`. Events emitted during startup recovery are
// delivered synchronously within the `start()` call. If the caller subscribes
// after `start()` resolves, startup recovery events are lost.
```

## Acceptance Criteria

### GitHub Client

- [ ] Given valid `GitHubClientConfig` values, when `createGitHubClient` is called, then it returns
      an object satisfying the `GitHubClient` interface with no type assertions in the adapter
      implementation.
- [ ] Given the engine codebase, when inspected, then no file outside `engine/github-client/`
      imports from `@octokit/rest` or `@octokit/auth-app`.

### Pollers

See `control-plane-engine-pollers.md` for all poller acceptance criteria.

### Dispatch

- [ ] Given a spec's frontmatter status is `draft` and its blob SHA changed, when the Engine Core
      processes the batch, then the Planner is not dispatched for that spec.
- [ ] Given the `dispatchImplementor` command is received for an issue with no complexity label,
      when the Implementor session is created, then no `modelOverride` is passed (agent definition
      default applies).
- [ ] Given the engine sets `status:review` on an issue via completion-dispatch, when the
      IssuePoller snapshot is updated to match, then the next IssuePoller cycle does not emit a
      duplicate `issueStatusChanged` for that issue.
- [ ] Given an Implementor `agentCompleted` event fires for issue N, when no non-draft PR is found,
      then no Reviewer is dispatched and no status change occurs.
- [ ] Given an Implementor `agentFailed` event fires for issue N, when the Engine Core processes the
      failure, then no PR check or Reviewer dispatch occurs.
- [ ] Given `status:review` is detected by the IssuePoller (set externally or by the engine on a
      previous cycle), when the dispatch logic processes the change, then no Reviewer is
      auto-dispatched.
- [ ] Given the `dispatchReviewer` command is received for issue N, when no linked open PR is found,
      then the dispatch is a no-op.
- [ ] Given the `dispatchReviewer` command is received for an issue whose status is not `review`,
      when the command is processed, then it is a no-op.
- [ ] Given the `dispatchReviewer` command is received for an issue not in the IssuePoller snapshot,
      when the command is processed, then it is a no-op.

### Agent Lifecycle

See `control-plane-engine-agent-manager.md` for all agent lifecycle, definition loading,
programmatic hooks, SDK session configuration, and stream accessor acceptance criteria.

### Recovery

See `control-plane-engine-recovery.md` for all recovery acceptance criteria.

### Planner Cache

See `control-plane-engine-planner-cache.md` for all planner cache acceptance criteria.

### Queries and Streams

- [ ] Given `getIssueDetails` is called for an issue with a `null` body, when the result is
      returned, then `body` is an empty string.
- [ ] Given `getIssueDetails` is called for an issue with labels in mixed format (bare strings and
      `{ name }` objects), when the result is returned, then `labels` contains extracted name
      strings from both formats.
- [ ] Given `getPRForIssue` is called with `includeDrafts: false`, when only a draft PR is linked,
      then it returns `null`.
- [ ] Given `getPRForIssue` is called with an issue number, when no linked PR exists, then it
      returns `null`.
- [ ] Given `getPRFiles` is called with a PR number, when a changed file is binary or exceeds the
      diff size limit, then the entry's `patch` field is absent and the entry is still included.
- [ ] Given `getPRFiles` is called with a PR number, when the PR has no changed files, then it
      returns an empty array.
- [ ] Given `getPRReviews` is called with a PR number, when no reviews or comments exist, then it
      returns empty arrays for both `reviews` and `comments`.
- [ ] Given `getPRReviews` encounters a review with `null` body, when the result is returned, then
      `body` is an empty string.
- [ ] Given `getPRReviews` encounters a review with no `user` object, when the result is returned,
      then `author` is an empty string.

Stream accessor (`getAgentStream`) acceptance criteria are in
[control-plane-engine-agent-manager.md](./control-plane-engine-agent-manager.md).

### Agent Session Logging

See
[control-plane-engine-agent-manager.md: Agent Session Logging](./control-plane-engine-agent-manager.md#agent-session-logging)
for all agent session logging acceptance criteria.

### Operational

- [ ] Given the `cancelAgent` command is received for issue N, when no agent is running for it, then
      the command is a no-op.
- [ ] Given the `cancelPlanner` command is received, when no Planner is running, then the command is
      a no-op.
- [ ] Given deferred spec paths include a path whose frontmatter status changed to non-approved
      since deferral, when the merged set is dispatched, then the non-approved path is dropped from
      the batch.
- [ ] Given an agent is running for issue N, when issue N is removed from the poll results (closed
      or label removed), then the agent session is cancelled, `agentFailed` is emitted before
      `issueRemoved`.
- [ ] Given an issue status changes to a user-dispatch status, when the Engine Core processes the
      change, then `issueStatusChanged` is emitted before `dispatchReady`.
- [ ] Given a Planner session fails, when the failure is detected, then the dispatched spec paths
      are re-added to the deferred buffer for the next dispatch attempt.

### Repository Root

- [ ] Given `createEngine` is called with an explicit `repoRoot` dependency, when the engine
      initializes, then it uses the provided value without running `git rev-parse`.
- [ ] Given the agent definition file does not exist at the expected path or contains malformed
      YAML, when the engine attempts to dispatch the agent, then the dispatch fails with an error
      (treated as agent session creation failure).
- [ ] Given `git rev-parse --show-toplevel` fails (not inside a git repository), when the engine
      initializes, then it logs an error and exits.

## Known Limitations

- **Pagination capped at 100 items per call.** All list endpoints (`issues.listForRepo`,
  `pulls.list`, `pulls.listFiles`, `pulls.listReviews`, `pulls.listReviewComments`) use
  `per_page: 100` without pagination. Repositories with more than 100 open task issues, 100 open
  PRs, 100 changed files per PR, or 100 reviews/comments per PR will have results silently
  truncated. Acceptable for the expected scale of managed repositories.
- **No Planner cancel keybinding in the TUI.** `cancelPlanner` is not exposed in the TUI — there is
  no keybinding to cancel the Planner. A hung Planner can be stopped by quitting the control plane
  (which triggers the graceful shutdown sequence, cancelling all agents after `shutdownTimeout`) or
  by waiting for `maxAgentDuration` timeout.
- **GitHub App rate limits handled by natural poll interval backoff only.** No explicit rate limit
  tracking or adaptive throttling. GitHub App installation tokens have a 5,000 request/hour limit;
  with default poll intervals (30s issues, 60s specs), steady-state usage is well within this
  budget.
- **Auth credentials validated lazily.** `@octokit/auth-app` validates credentials on the first API
  call, not at construction time. Invalid credentials (bad key, wrong app ID) cause the first poller
  cycle to fail and will fail indefinitely since invalid credentials never self-heal. The operator
  must fix the config and restart.

## Dependencies

- `@octokit/rest` — GitHub REST API client. Wrapped by the `GitHubClient` adapter; not imported
  directly outside `engine/github-client/`.
- `@octokit/auth-app` — GitHub App authentication strategy for `@octokit/rest`. Handles JWT
  creation, installation token exchange, and automatic token refresh.
- `@anthropic-ai/claude-agent-sdk` (≥0.2.x) — The v1 `query()` API is used for all agent
  invocations. Agent definitions are loaded inline by the engine (see
  [control-plane-engine-agent-manager.md: Agent Definition Loading](./control-plane-engine-agent-manager.md#agent-definition-loading))
  and passed via the `agents` option. The bash validator hook is passed via the `hooks` option (see
  [control-plane-engine-agent-manager.md: Programmatic Hooks](./control-plane-engine-agent-manager.md#programmatic-hooks)).
  `settingSources` is set to `[]` (empty) due to a worktree resolution bug — project context
  (CLAUDE.md) is injected manually via `contextPaths` (see
  [control-plane-engine-agent-manager.md: Project Context Injection](./control-plane-engine-agent-manager.md#project-context-injection)).
  See
  [control-plane-engine-agent-manager.md: SDK Session Configuration](./control-plane-engine-agent-manager.md#sdk-session-configuration)
  for the full call signature and option details.
- `gray-matter` — YAML frontmatter parser. Used by the `QueryFactory` to parse agent definition
  files (`.claude/agents/<name>.md`) into structured frontmatter + markdown body. Imported only in
  `engine/agent-manager/`.
- `agent-hook-bash-validator.md` — Normative validation rules for the Bash tool hook (blocklist,
  allowlist, segmentation). The engine provides a TypeScript implementation; see
  [control-plane-engine-agent-manager.md: Programmatic Hooks](./control-plane-engine-agent-manager.md#programmatic-hooks).
- `control-plane-engine-pollers.md` — IssuePoller and SpecPoller sub-spec
- `control-plane-engine-agent-manager.md` — Agent Manager sub-spec (lifecycle, SDK sessions,
  definition loading, hooks, streams, logging)
- `control-plane-engine-recovery.md` — Recovery sub-spec (startup and crash recovery)
- `control-plane-engine-planner-cache.md` — Planner Cache sub-spec
- `control-plane.md` — Parent architecture spec (dispatch tiers, worktree isolation, recovery
  policy)
- `workflow.md` — Status transition table, quality gates, escalation protocol
- `agent-planner.md` — Planner agent definition (invoked by auto-dispatch)
- `agent-implementor.md` — Implementor agent definition (invoked by user-dispatch)
- `agent-reviewer.md` — Reviewer agent definition (invoked by auto-dispatch)

## References

- `control-plane-engine-pollers.md` — Poller behavior, snapshot state, change detection, type
  definitions
- `control-plane-engine-agent-manager.md` — Agent lifecycle, SDK session configuration, stream
  accessor, session logging
- `control-plane-engine-recovery.md` — Startup and crash recovery behavior
- `control-plane-engine-planner-cache.md` — Planner cache format, seeding, write behavior
- `control-plane-tui.md` — TUI specification (consumes the engine's four interfaces: events,
  commands, queries, streams)
