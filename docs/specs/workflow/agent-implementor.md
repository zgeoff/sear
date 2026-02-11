---
title: Implementor Agent
version: 0.7.0
last_updated: 2026-02-11
status: approved
---

# Implementor Agent

## Overview

Agent that executes assigned tasks by reading task issues and referenced specs, writing code and
tests within declared scope, and surfacing blockers when it cannot proceed. An Implementor works on
one task at a time; parallelism is achieved by running multiple Implementor instances, not by
assigning multiple tasks to one agent.

## Constraints

- Must work on exactly one task at a time.
- Must use `scripts/workflow/gh.sh` for all GitHub CLI operations (see
  [skill-github-workflow.md: Authentication](./skill-github-workflow.md#authentication) for wrapper
  behavior).
- Must conform to the project's code style, naming conventions, and patterns defined in `CLAUDE.md`.
- Must use conventional commit format for commit messages and PR titles.
- Must not reprioritize tasks or change task sequencing. Executes what is assigned.
- Must not make interpretive decisions when the spec is ambiguous, contradictory, or incomplete.
  Escalate as a blocker instead.
- The agent definition body must include the permitted bash command list from
  [agent-hook-bash-validator.md: Allowlist Prefixes](./agent-hook-bash-validator.md#allowlist-prefixes)
  to prevent wasted turns on blocked commands.

## Agent Profile

| Constraint       | Value                                            | Rationale                                                                               |
| ---------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Model tier       | Opus (default)                                   | Implementation requires strong reasoning; overridden by engine based on task complexity |
| Tool access      | Full write (Read, Write, Edit, Grep, Glob, Bash) | Must create and modify source code and tests                                            |
| Turn budget      | 100                                              | Open-ended implementation work requires higher budget than analysis                     |
| Permission model | Non-interactive with bash validation             | Runs unattended; bash validator enforces command safety                                 |

The agent definition (`.claude/agents/implementor.md`) implements these constraints as frontmatter.
The Engine overrides the model at dispatch time based on the task's complexity label (see
[control-plane-engine.md: Dispatch Logic](./control-plane-engine.md#dispatch-logic)). See
[control-plane-engine-agent-manager.md: Agent Definition Loading](./control-plane-engine-agent-manager.md#agent-definition-loading)
for how the Engine parses frontmatter.

## Trigger

The Implementor is invoked with a task issue number under three scenarios:

1. **New task** — A `status:pending` task is selected for implementation.
2. **Task unblocked** — A previously blocked task moves to `status:unblocked`.
3. **Task needs changes** — A reviewed task moves to `status:needs-changes`.

The agent determines the scenario from the task's current status label.

## Inputs

The Engine injects the following into the agent's session at dispatch time (see
[control-plane-engine-agent-manager.md: Trigger Context](./control-plane-engine-agent-manager.md#trigger-context)
and [Project Context Injection](./control-plane-engine-agent-manager.md#project-context-injection)):

1. **Trigger prompt:** The task issue number (e.g., `"42"`).
2. **Project context:** CLAUDE.md content (coding conventions, style rules, architecture) appended
   to the agent's system prompt.
3. **Working directory:** A git worktree (see
   [control-plane-engine-agent-manager.md: Agent Lifecycle](./control-plane-engine-agent-manager.md#agent-lifecycle),
   step 2). For new tasks, the worktree is on a fresh branch. For resumed tasks (`status:unblocked`,
   `status:needs-changes`), the worktree is on the existing PR branch.

The agent fetches all remaining data via tool calls: the task issue body, referenced spec sections,
in-scope file state, and (for resumed tasks) existing PR and review comments.

## Input Validation

Before starting work, the agent validates:

1. **Task structure** — The task issue contains all required sections: Objective, Spec Reference,
   Scope (with In Scope list), and Acceptance Criteria.
2. **Spec reference** — The spec file exists and has `status: approved` in its frontmatter.
3. **Status label** — The task's current status label is one of: `status:pending`,
   `status:unblocked`, `status:needs-changes`.
4. **Existing PR** (resume only) — For `status:unblocked` or `status:needs-changes`, a PR linked to
   the task issue exists.

If any check fails, the agent posts a comment using the Validation Failure Comment format (see
[workflow-contracts.md: Validation Failure Comment](./workflow-contracts.md#validation-failure-comment))
and stops. The agent does not change the status label on validation failure.

## Execution Scenarios

The agent's behavior differs based on the task's status label at invocation. All scenarios share the
same input validation and scope enforcement rules.

### New Task (status:pending)

The agent transitions the label to `status:in-progress` before any code changes, then implements the
task and submits a ready-for-review PR linked to the task issue via `Closes #<issue-number>`. The PR
title follows conventional commit format. The branch name is assigned by the engine — the agent
pushes on whatever branch its worktree starts on.

### Resume from Unblocked (status:unblocked)

The worktree is on the existing PR branch. The agent reviews the original blocker and any resolution
comments, transitions the label to `status:in-progress`, then continues implementation from
preserved progress. On completion, the existing draft PR is converted to ready-for-review (not a new
PR).

### Resume from Needs-Changes (status:needs-changes)

The worktree is on the existing PR branch. The agent reads the PR review comments to understand
requested changes, transitions the label to `status:in-progress`, then addresses each review comment
within scope. Fixes are pushed to the existing PR — no new PR is opened, and the draft-to-ready
conversion does not apply (the PR is already ready-for-review).

If a review comment requests changes to out-of-scope files, the agent posts an escalation comment
(see
[workflow-contracts.md: Escalation Comment Format](./workflow-contracts.md#escalation-comment-format))
explaining the scope constraint and continues with in-scope fixes.

### Test Verification

In all scenarios, the agent runs tests locally before completing. If tests fail due to the agent's
changes, it fixes and re-runs. If tests fail due to something outside the agent's scope
(pre-existing failure, broken dependency), it treats the failure as a blocker.

## Blocker Handling

When the agent encounters something that prevents continued progress:

1. Stop work immediately.
2. Open a draft PR to preserve progress (if no PR exists yet).
3. Post a blocker comment on the task issue using the Blocker Comment Format (see
   [workflow-contracts.md: Blocker Comment Format](./workflow-contracts.md#blocker-comment-format)).
4. Transition the label from `status:in-progress` to:
   - `status:needs-refinement` for spec blockers (ambiguity, contradiction, gap)
   - `status:blocked` for non-spec blockers (external dependency, technical constraint)

### Escalations

When the agent identifies a non-blocking issue (e.g., scope conflict with another task, priority
conflict, judgment call), it posts an escalation comment using the Escalation Comment Format (see
[workflow-contracts.md: Escalation Comment Format](./workflow-contracts.md#escalation-comment-format))
and continues working. Escalations do not stop work and do not change the status label. If the issue
later prevents progress, it becomes a blocker.

## Scope Enforcement

The agent must only modify files listed in the task issue's "In Scope" section, subject to the scope
enforcement rules defined in
[workflow-contracts.md: Scope Enforcement Rules](./workflow-contracts.md#scope-enforcement-rules)
(primary scope, co-located test files, incidental changes).

When non-incidental changes to out-of-scope files are needed:

- If it blocks progress: treat as a blocker (type: `technical-constraint`).
- If it does not block progress: post an escalation (type: `scope-conflict`) and continue.

## Status Transitions

| From                   | To                        | When                               |
| ---------------------- | ------------------------- | ---------------------------------- |
| `status:pending`       | `status:in-progress`      | Starting work on a new task        |
| `status:unblocked`     | `status:in-progress`      | Resuming a previously blocked task |
| `status:needs-changes` | `status:in-progress`      | Resuming after reviewer feedback   |
| `status:in-progress`   | `status:needs-refinement` | Blocked by spec issue              |
| `status:in-progress`   | `status:blocked`          | Blocked by non-spec issue          |

The agent must not perform any other status transitions.

## Completion Output

On every run (success, blocker, or validation failure), the agent returns the Implementor Completion
Output (see
[workflow-contracts.md: Implementor Completion Output](./workflow-contracts.md#implementor-completion-output))
as its final text output to the invoking process.

## Acceptance Criteria

- [ ] Given a `status:pending` task, when the agent starts work, then the label is updated to
      `status:in-progress` before any code changes are made.
- [ ] Given a task issue with a "Spec Reference" field, when the agent starts work, then it reads
      the referenced spec file and sections before writing code.
- [ ] Given a task issue missing a required section (Objective, Spec Reference, Scope, or Acceptance
      Criteria), when the agent validates inputs, then it posts a validation failure comment and
      stops without changing the status label.
- [ ] Given a task whose referenced spec file does not exist or is not `status: approved`, when the
      agent validates inputs, then it posts a validation failure comment and stops without changing
      the status label.
- [ ] Given a task with an unexpected status label (not `status:pending`, `status:unblocked`, or
      `status:needs-changes`), when the agent validates inputs, then it posts a validation failure
      comment and stops without changing the status label.
- [ ] Given a task with an "In Scope" file list, when the agent completes work, then only files in
      primary scope, co-located test files, and incidental changes have been modified.
- [ ] Given a satisfiable task, when the agent completes work, then a ready-for-review PR exists
      linked to the task issue via `Closes #<issue-number>`.
- [ ] Given a satisfiable task, when the agent completes work, then all tests pass locally before
      the session ends.
- [ ] Given a spec ambiguity during implementation, when the agent stops work, then a draft PR
      preserves progress, a blocker comment is posted, and the label is `status:needs-refinement`.
- [ ] Given a non-spec blocker during implementation, when the agent stops work, then a draft PR
      preserves progress, a blocker comment is posted, and the label is `status:blocked`.
- [ ] Given a blocker comment, when reviewed, then it contains a Type, Description, at least two
      Options with trade-offs, and a Recommendation.
- [ ] Given a spec blocker comment, when reviewed, then it includes a Spec Reference with file path,
      section name, and quote.
- [ ] Given a `status:unblocked` task, when the agent resumes, then it continues from preserved
      progress on the existing PR branch.
- [ ] Given a `status:unblocked` task, when the agent completes, then the existing draft PR is
      converted to ready-for-review.
- [ ] Given a `status:needs-changes` task, when the agent resumes, then it pushes fixes to the
      existing PR branch.
- [ ] Given a needs-changes review comment requesting out-of-scope changes, then the agent posts an
      escalation comment and continues with in-scope fixes.
- [ ] Given a non-blocking issue (scope conflict, priority conflict), when the agent posts an
      escalation, then it continues working and does not change the status label.
- [ ] Given the agent finishes execution (any outcome), then it returns a completion summary
      matching the Implementor Completion Output format.

## Dependencies

- `scripts/workflow/gh.sh` — Authenticated `gh` CLI wrapper (see
  `docs/specs/workflow/github-cli.md`). All GitHub operations (label changes, issue comments, PR
  creation and updates).
- Project testing framework — Tests must be runnable locally via the commands defined in
  `CLAUDE.md`.
- `CLAUDE.md` — Code style, naming conventions, and patterns that the agent must conform to.
- `workflow-contracts.md` — Shared data formats: Validation Failure Comment, Blocker Comment Format,
  Escalation Comment Format, Implementor Completion Output, Scope Enforcement Rules.
- Agent Bash Tool Validator — PreToolUse hook that validates all Bash commands against
  blocklist/allowlist before execution. See `agent-hook-bash-validator.md` (rules) and
  `agent-hook-bash-validator-script.md` (shell implementation).

## References

- `docs/specs/workflow/workflow.md` — Development Protocol (Implementor role, Implementation Phase)
- `docs/specs/workflow/skill-github-workflow.md` — GitHub Workflow Skill spec (reference for `gh`
  command patterns and label rules; not loaded at runtime)
- `docs/specs/workflow/github-cli.md` — GitHub CLI wrapper spec
- `docs/specs/workflow/script-label-setup.md` — Label definitions for the repository
