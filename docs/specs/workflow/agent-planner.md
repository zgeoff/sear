---
title: Planner Agent
version: 0.4.0
last_updated: 2026-02-11
status: approved
---

# Planner Agent

## Overview

Agent that analyzes spec commits and decomposes work into executable GitHub Issues. The Planner is
triggered when a specification is committed or updated in `docs/specs/`. It reviews existing issues
for relevance, assesses what work remains against the current codebase, decomposes the spec into
hermetic tasks, and creates well-structured GitHub Issues with proper labels, dependencies, and
priority.

## Constraints

- Must use `scripts/workflow/gh.sh` for all GitHub CLI operations (see
  [skill-github-workflow.md: Authentication](./skill-github-workflow.md#authentication) for wrapper
  behavior).
- Must not narrate reasoning between tool calls. Output only: gate check results, issue action
  summaries (created/updated/closed with number and title), and the final planning summary. No
  exploratory commentary.
- Must not make interpretive decisions about spec intent. Ambiguity, contradiction, or gaps must
  produce `task:refinement` issues, not guesses.
- The agent definition body must include the permitted bash command list from
  [agent-hook-bash-validator.md: Allowlist Prefixes](./agent-hook-bash-validator.md#allowlist-prefixes)
  to prevent wasted turns on blocked commands.

## Agent Profile

| Constraint       | Value                                   | Rationale                                                           |
| ---------------- | --------------------------------------- | ------------------------------------------------------------------- |
| Model tier       | Sonnet                                  | Decomposition and issue creation; Opus not required                 |
| Tool access      | No write tools (Read, Grep, Glob, Bash) | Reads codebase and creates issues via `gh.sh`; never modifies files |
| Turn budget      | 50                                      | Bounded analysis with batch issue creation                          |
| Permission model | Non-interactive with bash validation    | Runs unattended; bash validator enforces command safety             |

The agent definition (`.claude/agents/planner.md`) implements these constraints as frontmatter. See
[control-plane-engine-agent-manager.md: Frontmatter Field Mapping](./control-plane-engine-agent-manager.md#frontmatter-field-mapping)
for how the Engine parses them.

## Trigger

The Planner is invoked when one or more specification files are committed or updated in
`docs/specs/`. The trigger mechanism is defined by the Engine (see
[control-plane-engine.md: Spec Polling](./control-plane-engine.md#spec-polling)).

When multiple specs change in the same poll cycle, they are all included in a single invocation.

## Inputs

### Injected Context

The Engine Core pre-computes and injects the following into the Planner's trigger prompt (see
[control-plane-engine-agent-manager.md: Planner Context Pre-computation](./control-plane-engine-agent-manager.md#planner-context-pre-computation)):

1. **Spec content:** Full content of each changed spec, including frontmatter, acceptance criteria,
   and dependencies. The Planner does not need to read spec files from disk.
2. **Spec diffs:** For modified specs, a unified diff showing what changed since the last successful
   Planner run. Added specs have no diff.
3. **Existing GitHub Issues:** All open `task:implement` and `task:refinement` issues with number,
   title, labels, and body.

### Codebase State

Codebase state is not injected. The Planner reads the current codebase via tool calls (Read, Grep,
Glob) to assess what work is already done vs. what remains. This is the Planner's primary tool-use
activity.

## Idempotency

The Engine does not prevent re-dispatch for the same spec (e.g., a whitespace-only change will
re-trigger the Planner). The Planner is responsible for idempotency: a re-invocation where existing
issues are current and the codebase satisfies all criteria must produce no new issues, no closed
issues, and no updates. The pre-planning gates and existing issue review (Phases 1-2) are the
mechanisms that ensure this.

## Pre-Planning Gates

Before decomposition, the Planner validates the following quality gates for each input spec. Gates
are evaluated per spec — a failing spec is reported and skipped; passing specs proceed.

1. Spec frontmatter `status` is `approved`.
2. No open `task:refinement` issues exist for this spec.

For each spec that fails a gate, the Planner outputs a failure report using the Planning Gate
Failure Format (see
[workflow-contracts.md: Planning Gate Failure Format](./workflow-contracts.md#planning-gate-failure-format)).
If all specs fail, the Planner stops after reporting all failures.

## Decomposition Process

The Planner executes the following phases in order. The ordering is a contract — each phase depends
on the output of the previous one.

### Phase 1: Review Existing Issues

Before creating new issues, the Planner reviews all open issues in the injected context that
reference any of the input specs. An issue references a spec if its body contains the spec file path
in the "Spec Reference" section. Issues that do not reference any input spec are ignored.

The Planner identifies and acts on:

1. **Irrelevant tasks:** Issues whose referenced spec section has been removed or whose work is no
   longer needed due to spec changes. Closed with an explanatory comment.
2. **Stale tasks:** Issues whose scope or acceptance criteria no longer match the updated spec.
   Updated in place (body, labels, acceptance criteria) with a comment explaining the revision.

When a new issue supersedes an existing open issue, the existing issue is closed as a duplicate with
a comment referencing the new issue number. Duplicate closure happens after the new issue is created
so the reference is available.

### Phase 2: Assess Delta

Compare acceptance criteria across all input specs against the current codebase:

- Criteria already satisfied by the codebase do not need tasks.
- Criteria not satisfied (or partially satisfied) become the basis for task decomposition.

### Phase 3: Decompose into Tasks

Break remaining work into tasks. Each task must be:

- **Single objective:** One clear thing to accomplish.
- **Hermetic:** Completable by one Implementor without real-time coordination.
- **Bounded:** Explicit In Scope and Out of Scope file lists. When two tasks could touch the same
  file, define non-overlapping boundaries (e.g., one task handles type definitions, another handles
  the implementation).
- **Derived:** Acceptance criteria come from the spec (subset of spec criteria, plus
  implementation-specific criteria).
- **Referenced:** Links to the specific spec file and section(s) it implements.
- **Right-sized:** Completable in a single Implementor invocation. Split large work into sequential
  tasks with dependencies.

### Phase 4: Create GitHub Issues

Create each task issue using the Task Issue Template (see
[workflow-contracts.md: Task Issue Template](./workflow-contracts.md#task-issue-template)).

Each `task:implement` issue receives exactly four labels: type (`task:implement`), status
(`status:pending`), priority, and complexity. Each `task:refinement` issue receives exactly three
labels (no complexity).

### Phase 5: Report Summary

After all issues are created/updated/closed, the Planner outputs a planning summary as its final
text output (see [Completion Output](#completion-output)).

## Complexity Assessment

For each task, the Planner assigns a complexity label that determines the Implementor's model:

- `complexity:simple` — Single-file changes, mechanical transformations, straightforward CRUD,
  boilerplate. The Implementor runs with Sonnet.
- `complexity:complex` — Multi-file coordination, architectural decisions, nuanced logic,
  non-trivial error handling. The Implementor runs with Opus.

When in doubt, prefer `complexity:complex` — the cost of under-resourcing a task (wasted turns, poor
output) exceeds the cost of over-resourcing (higher token cost). See `script-label-setup.md` for
label definitions and
[control-plane-engine.md: Dispatch Logic](./control-plane-engine.md#dispatch-logic) for how the
engine maps complexity labels to model overrides.

## Priority Assignment

- `priority:high` — Blocks other tasks or is on the critical path. Foundation work (types, core
  interfaces) that other tasks depend on.
- `priority:medium` — Default. Standard implementation work with no special urgency.
- `priority:low` — Nice-to-have, non-blocking, or can be deferred without impacting other work.

The Planner sequences tasks so that foundational work is created first as `priority:high`, with
dependent tasks referencing them via "Blocked by #X" in the Context section and GitHub issue
references.

## Spec Ambiguity Handling

When the Planner encounters ambiguity, contradiction, or a gap in the spec that prevents task
decomposition:

1. Create a `task:refinement` issue using the Refinement Issue Template (see
   [workflow-contracts.md: Refinement Issue Template](./workflow-contracts.md#refinement-issue-template)).
2. Do not create tasks that depend on the ambiguous section until the spec is clarified.
3. Continue creating tasks for unambiguous sections.

Refinement issues default to `priority:high` because they block task creation. Use `priority:medium`
only if the ambiguous section does not block critical-path work.

## Completion Output

On every run, the Planner returns one of:

- **Planning Summary** (see
  [workflow-contracts.md: Planning Summary Format](./workflow-contracts.md#planning-summary-format))
  — when at least one spec passed its gates and decomposition ran.
- **Gate Failure reports only** (see
  [workflow-contracts.md: Planning Gate Failure Format](./workflow-contracts.md#planning-gate-failure-format))
  — when all specs failed their gates.

## Acceptance Criteria

- [ ] Given a spec with `status: approved`, when the Planner runs, then it produces GitHub Issues
      for all unsatisfied acceptance criteria.
- [ ] Given a spec with `status` other than `approved`, when the Planner runs, then it skips that
      spec with a gate failure report and continues processing remaining specs.
- [ ] Given open `task:refinement` issues exist for a spec, when the Planner runs, then it skips
      that spec with a gate failure report.
- [ ] Given existing open issues that reference a removed spec section, when the Planner runs on the
      updated spec, then those issues are closed with an explanatory comment.
- [ ] Given existing open issues with outdated acceptance criteria, when the Planner runs on the
      updated spec, then those issues are updated to match the current spec.
- [ ] Given an existing open issue that is superseded by a new issue, when the Planner creates the
      new issue, then the existing issue is closed as a duplicate with a reference to the new issue
      number.
- [ ] Given acceptance criteria that the codebase already satisfies, when the Planner runs, then no
      tasks are created for those criteria.
- [ ] Given the Planner creates tasks, when each task issue is inspected, then it contains all
      required sections: Objective, Spec Reference, Scope (In Scope / Out of Scope), Acceptance
      Criteria, Context, Constraints.
- [ ] Given the Planner creates a `task:implement` issue, when the issue is inspected, then it has
      exactly four labels: `task:implement`, `status:pending`, one priority label, and one
      complexity label.
- [ ] Given the Planner creates a `task:refinement` issue, when the issue is inspected, then it has
      exactly three labels: `task:refinement`, `status:pending`, and one priority label (no
      complexity label).
- [ ] Given two tasks that could touch the same file, when the Planner creates them, then their
      scope sections define non-overlapping boundaries.
- [ ] Given a task that depends on another task, when the task issue is inspected, then it includes
      "Blocked by #X" referencing the dependency.
- [ ] Given foundational work (types, interfaces, core modules), when the Planner creates the task,
      then it is marked `priority:high`.
- [ ] Given an ambiguous section in the spec, when the Planner encounters it, then it creates a
      `task:refinement` issue instead of guessing intent.
- [ ] Given the Planner completes, then it outputs a planning summary listing all closed, updated,
      and newly created issues with priorities and dependencies.
- [ ] Given a re-invocation where existing issues are current and the codebase satisfies all
      criteria, then no new issues are created, no issues are closed, and no issues are updated.

## Dependencies

- `scripts/workflow/gh.sh` — Authenticated `gh` CLI wrapper (see
  `docs/specs/workflow/github-cli.md`).
- Label setup — All workflow labels must exist in the repository (see `script-label-setup.md`).
- `workflow-contracts.md` — Shared data formats: Task Issue Template, Refinement Issue Template,
  Planning Gate Failure Format, Planning Summary Format.
- Agent Bash Tool Validator — PreToolUse hook that validates all Bash commands against
  blocklist/allowlist before execution. See `agent-hook-bash-validator.md` (rules) and
  `agent-hook-bash-validator-script.md` (shell implementation).
- [control-plane-engine-agent-manager.md: Planner Context Pre-computation](./control-plane-engine-agent-manager.md#planner-context-pre-computation)
  — Engine builds the enriched trigger prompt.
- `control-plane-engine-planner-cache.md` — Planner cache for diff computation (last successful run
  state).

## References

- `docs/specs/workflow/workflow.md` — Development Protocol (Planner role, Planning Phase)
- `docs/specs/workflow/script-label-setup.md` — Label definitions for the repository
- `docs/specs/workflow/skill-github-workflow.md` — GitHub Workflow Skill spec (reference for `gh`
  command patterns and label rules; not loaded at runtime)
- `docs/specs/workflow/github-cli.md` — GitHub CLI wrapper spec
- [control-plane-engine.md: Dispatch Logic](./control-plane-engine.md#dispatch-logic) — Planner
  auto-dispatch and complexity-based model override
