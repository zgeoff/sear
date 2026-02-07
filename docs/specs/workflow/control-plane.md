---
title: Agentic Workflow Control Plane
version: 0.1.0
last_updated: 2026-02-08
status: approved
---

# Agentic Workflow Control Plane

## Overview

The control plane is an interactive, long-running TUI application that operates the development workflow defined in `workflow.md`. It monitors GitHub Issues and spec files for state changes, automatically dispatches agents where policy allows, surfaces actionable items to the user, and provides on-demand agent invocation for tasks requiring human judgment.

It is the single interface through which the Human role interacts with the automated workflow — observing state, dispatching agents, and responding to notifications.

## Constraints

- Must be manually started. Does not auto-start or run as a system service.
- Must remain interactive while agents run. The user can observe, dispatch, and respond at any time.
- Must not invoke agents concurrently for the same task issue. One agent per issue at a time.
- Must auto-recover stale `status:in-progress` issues when no agent is running for them (reset to `status:pending`).
- Must only auto-dispatch the Planner for specs with `status: approved` in frontmatter.
- Must use `@octokit/rest` with `@octokit/auth-app` for all GitHub API interactions.
- Must use `@anthropic-ai/claude-agent-sdk` for all agent invocations.

## Specification

### Architecture

The control plane consists of two co-located modules in a single process:

- **Engine** — Polling, state management, change detection, agent lifecycle, and dispatch logic. Owns all workflow state. Has no knowledge of the TUI.
- **TUI** — Ink-based (React for terminal) dashboard that renders engine state and captures user input. Consumes the engine; never imported by it.

Both modules live in the `@sear/agentic-workflow` workspace package at `agentic-workflow/` in the repository root. They are separate modules with explicit exports, not separate packages.

### Data Flow

The engine exposes four interfaces:

1. **Event emitter** — The engine emits typed events when state changes occur (issue status changed, agent started, agent completed, change detected, etc.). The TUI subscribes to these events for reactive state updates.
2. **Command interface** — The engine accepts commands (dispatch implementor for issue N, cancel agent for issue N, shutdown, etc.). The TUI invokes these in response to user input.
3. **Query interface** — The engine provides on-demand data fetching (issue details, PR summaries). The TUI calls these when the user selects an issue that needs additional data not tracked by pollers.
4. **Stream accessor** — The engine exposes live agent output streams. The TUI subscribes to these directly for streaming agent output in the detail pane, separate from the event emitter.

The TUI bridges these interfaces to React via a Zustand store initialized by a `useEngine()` hook:

- The store subscribes to engine events in its initializer and updates state reactively.
- Store actions wrap engine commands.
- Components use `useStore()` with selectors to subscribe to specific state slices.
- This hook is the only coupling point between engine and TUI.

```mermaid
flowchart LR
    subgraph Process["Single Process"]
        subgraph Engine
            Polling
            State
            Agents
            Detection
        end

        subgraph TUI["TUI (Ink)"]
            Hook["useEngine() hook"]
            Dashboard["Dashboard Components"]
        end

        Engine -- "events" --> Hook
        Engine -- "streams" --> Hook
        Hook -- "commands" --> Engine
        Hook -- "queries" --> Engine
        Hook --> Dashboard
    end
```

### Dispatch Tiers

The control plane categorizes state changes into three tiers that determine how they are handled:

| Tier | Behavior | Triggers |
|------|----------|----------|
| **Auto-dispatch** | Agent invoked automatically, no user action needed | Spec changes (approved only) → Planner; `status:review` → Reviewer |
| **User-dispatch** | Surfaced in TUI, user chooses when to invoke | Issues with `status:pending`, `status:unblocked`, `status:needs-changes` → Implementor |
| **Notify-only** | User notified for action outside the control plane | `status:needs-refinement` (with clipboard command), `status:blocked` (URL only), `status:approved` (ready to merge) |

Dispatch decisions are based solely on status labels and dispatch tier classification. The engine does not enforce task dependencies (e.g., "Blocked by #X" references in issue bodies). Dependency ordering is the Human's responsibility when deciding which user-dispatch tasks to invoke.

The engine determines the tier. The TUI renders accordingly — auto-dispatched agents appear as running, user-dispatch items appear as actionable, and notifications appear with copy-to-clipboard commands.

Notifications are dismissed automatically when the underlying issue status changes.

### Agent Invocation

Agents are invoked programmatically using the `@anthropic-ai/claude-agent-sdk`. Each agent is configured with a system prompt from its agent definition file (`.claude/agents/<agent>.md`) and receives trigger-specific context (issue number, changed spec file paths, etc.).

The SDK provides structured lifecycle management — the engine creates agent sessions, monitors their progress, and handles completion without subprocess coordination.

The Planner receives all changed spec paths from the poll cycle in a single invocation (batched, not per-file).

### Recovery

The engine performs status recovery in two cases:

1. **Startup recovery** — On initialization, any issue with `status:in-progress` and no running agent is reset to `status:pending`.
2. **Agent failure recovery** — If an agent session completes (success or failure) and the issue is still `status:in-progress`, the engine resets it to `status:pending`.

Recovery is the only case where the engine writes to GitHub Issues. All other GitHub writes are performed by the agents themselves.

### Technology

| Choice | Detail |
|--------|--------|
| Language | TypeScript |
| Execution | `tsx` (no build step) |
| Package | `@sear/agentic-workflow` at `agentic-workflow/` |
| Run command | `yarn agentic-workflow` |
| TUI framework | Ink (React for terminal) |
| TUI state management | Zustand |
| GitHub API | `@octokit/rest` |
| GitHub Auth | `@octokit/auth-app` |
| Agent invocation | `@anthropic-ai/claude-agent-sdk` |
| Configuration | TypeScript config file |

### API Duality

Agents and the engine use different GitHub API clients by design:

- **Agents** use the `gh` CLI, authenticated via `GH_TOKEN` from `get-github-token.sh`. Each agent session gets a fresh token at invocation.
- **Engine** uses `@octokit/rest` with `@octokit/auth-app`, authenticated via GitHub App credentials in config. Token refresh is handled automatically.

Consequences for implementors:
- No code sharing for GitHub operations between engine and agents.
- Different error shapes and retry patterns — `gh` returns exit codes and stderr; `@octokit/rest` throws typed errors.
- The control plane never uses `gh` CLI; agents never use `@octokit/rest`.

### Worktree Isolation

Each Implementor agent runs in a dedicated git worktree, isolating parallel implementors from each other and from the main working tree.

**Lifecycle:**

1. **Create on dispatch** — When the engine dispatches an Implementor for issue N, it creates a worktree before creating the agent session. The worktree is created from the current `main` branch with a branch named `issue-<number>` (e.g., `issue-42`).
2. **Agent runs in worktree** — The agent session is created with its working directory set to the worktree path. All file operations are isolated to that worktree.
3. **Cleanup on success** — When the agent session succeeds, the engine removes the worktree via `git worktree remove`.
4. **Preserve on failure** — When the agent session fails, the engine leaves the worktree in place so the user can inspect it. The worktree path is surfaced in the TUI.

**Naming:**

| Artifact | Convention | Example |
|----------|------------|---------|
| Branch | `issue-<number>` | `issue-42` |
| Worktree directory | `<repo-root>/.worktrees/issue-<number>` | `.worktrees/issue-42` |

**Constraints:**

- The `.worktrees/` directory must be added to `.gitignore`.
- The engine must check for an existing worktree/branch for the issue before creating a new one. If one exists (e.g., from a previous failed run), reuse it.
- Only Implementor agents use worktrees. Planner and Reviewer agents operate on the main working tree.
- The `issue-<number>` branch is a working branch created by the engine. The Implementor agent is responsible for renaming it to follow the `<type>/<issue-number>-<short-description>` branch convention (per `workflow.md` quality gates) before pushing and opening a PR.

## Acceptance Criteria

- [ ] Given the control plane is started, when startup completes, then the TUI renders and the engine begins polling.
- [ ] Given a spec with `status: approved` is committed, when the next poll cycle runs, then the Planner is auto-dispatched without user interaction.
- [ ] Given a task issue moves to `status:review`, when the next poll cycle runs, then the Reviewer is auto-dispatched without user interaction.
- [ ] Given a task issue is `status:pending`, when the TUI displays it, then the user can dispatch an Implementor for it on demand.
- [ ] Given a task issue moves to `status:needs-refinement`, when the TUI displays the notification, then a clipboard-ready CLI command is provided.
- [ ] Given a notification's underlying issue status changes, when the next poll cycle runs, then the notification is dismissed.
- [ ] Given an agent is running, when the user presses a key, then the TUI processes the keypress and re-renders within one render cycle (no blocking on agent I/O).
- [ ] Given the engine emits an event, when the TUI is subscribed, then the TUI re-renders to reflect the new state.
- [ ] Given an issue is `status:in-progress` with no running agent at startup, when initialization completes, then the issue is reset to `status:pending`.
- [ ] Given an agent session completes and the issue is still `status:in-progress`, when the completion is detected, then the issue is reset to `status:pending`.
- [ ] Given the engine dispatches an Implementor for issue N, when the agent session is created, then it runs in a worktree at `.worktrees/issue-<N>` on a branch named `issue-<N>`.
- [ ] Given an Implementor agent session succeeds, when cleanup runs, then the worktree is removed.
- [ ] Given an Implementor agent session fails, when the failure is detected, then the worktree is preserved and its path is surfaced in the TUI.
- [ ] Given a worktree already exists for issue N (from a prior run), when the engine dispatches an Implementor for issue N, then the existing worktree is reused.

## Dependencies

- `control-plane-engine.md` — Engine specification (polling, state, dispatch logic, agent lifecycle)
- `control-plane-tui.md` — TUI specification (layout, interactions, rendering)
- `workflow.md` — Development workflow definition (roles, phases, status transitions)
- `agent-planner.md` — Planner agent definition
- `agent-implementor.md` — Implementor agent definition
- `agent-reviewer.md` — Reviewer agent definition

## References

