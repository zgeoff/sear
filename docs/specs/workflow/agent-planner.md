---
title: Planner Agent
version: 0.1.0
last_updated: 2026-02-06
status: review
---

# Planner Agent

## Overview

Agent that analyzes spec commits and decomposes work into executable GitHub Issues. The Planner is triggered when a specification is committed or updated in `docs/specs/`. It reviews existing issues for relevance, decomposes the spec into hermetic tasks, and creates well-structured GitHub Issues with proper labels, dependencies, and priority.

## Constraints

- Must not assign tasks to Implementors
- Must not modify code outside `docs/specs/` (reads specs, writes only GitHub Issues)
- Must not create tasks for specs that are not `approved` status
- Must review existing GitHub Issues before creating new ones to avoid duplicates
- Must use the `gh` CLI (via skill-github-workflow) for all GitHub operations
- Must not make interpretive decisions about spec intent -- if a spec is ambiguous, the Planner creates a `task:refinement` issue instead of guessing
- Each task must be hermetic: completable without real-time coordination with other agents
- Must not reprioritize tasks created by previous planning runs unless the spec has changed

## Specification

### Trigger

The Planner is invoked when a specification file is committed or updated in `docs/specs/`. The trigger mechanism (polling, webhook, manual invocation) is defined by the workflow dispatcher and is outside the scope of this spec.

The Planner receives as input the path(s) to the spec file(s) that were committed or updated.

### Inputs

The Planner reads the following before producing any output:

1. **Spec file(s):** The committed or updated spec(s) in `docs/specs/`. The Planner reads the full spec content including frontmatter, acceptance criteria, and dependencies.
2. **Spec diff:** The diff between the two most recent commits that touched the spec file, to understand what was added, modified, or removed. If only one commit exists (new spec), the entire spec is treated as new content.
3. **Existing GitHub Issues:** All open issues in the repository, including their labels, bodies, and linked spec references. Fetched via `gh issue list`.
4. **Codebase state:** The current state of files referenced by the spec's scope, to assess what work is already done vs. what remains.

### Pre-Planning: Validate Entry Criteria

Before creating any tasks, the Planner verifies the following quality gates:

1. Spec frontmatter `status` is `approved`.
2. All acceptance criteria in the spec are testable (contain observable outcomes).
3. The spec is committed to the repository (not just local changes).
4. No open `task:refinement` issues exist for this spec.

If any gate fails, the Planner stops and reports which gate(s) failed as its final text output, returned to whatever process invoked it. It does not create tasks. The failure report uses the following format:

```
## Planning Gate Failure

**Spec:** docs/specs/<name>.md

### Failed Gates
- Gate 1: Spec status is `<actual status>` (required: `approved`)
- Gate 4: Open `task:refinement` issues: #12, #15

### Action Required
What must be resolved before the Planner can process this spec.
```

### Phase 1: Review Existing Issues

Before creating new issues, the Planner reviews all open issues that reference the current spec. An issue references a spec if its body contains the spec file path in the "Spec Reference" section (e.g., `docs/specs/feature-name.md`). Issues that do not reference the current spec are ignored.

The Planner identifies:

1. **Irrelevant tasks:** Issues whose referenced spec section has been removed or whose work is no longer needed due to spec changes. These are closed with a comment explaining why (e.g., "Closed: spec section removed in latest update").
2. **Stale tasks:** Issues whose scope or acceptance criteria no longer match the updated spec. These are updated in place: body, labels, and acceptance criteria are revised to match the current spec.

The Planner comments on every issue it closes or modifies, explaining the reason and referencing the spec change.

### Phase 2: Assess Delta

The Planner compares the spec's requirements against the current codebase to determine what work remains:

1. Read each acceptance criterion in the spec.
2. For each criterion, check whether the current codebase already satisfies it.
3. Criteria that are already satisfied do not need tasks.
4. Criteria that are not satisfied (or partially satisfied) become the basis for task decomposition.

### Phase 3: Decompose into Tasks

The Planner breaks remaining work into tasks. Each task:

- Has a single, clear objective
- Is hermetic: can be completed by one Implementor without real-time coordination
- Has explicit scope boundaries (files/modules it may and may not touch)
- Has acceptance criteria derived from the spec (subset of spec criteria, plus any implementation-specific criteria)
- References the specific spec file and section(s) it implements

#### Task Sizing

Tasks should be sized so that an Implementor can complete one in a single working session. If a spec section requires work that is too large for one task, split it into sequential tasks with explicit dependencies.

#### Scope Boundaries

For each task, the Planner defines:

- **In Scope:** Files and modules the task may create or modify.
- **Out of Scope:** Files and modules explicitly excluded, with references to other task numbers that own them (e.g., "path/to/other.ts (owned by #45)").

When two tasks could reasonably touch the same file, the Planner must define clear boundaries (e.g., one task handles the type definitions, another handles the implementation).

### Phase 4: Create GitHub Issues

For each task, the Planner creates a GitHub Issue using the following template:

```markdown
## Objective
One sentence: what this task achieves.

## Spec Reference
- Spec: `docs/specs/<name>.md`
- Section(s): <relevant sections>

## Scope

### In Scope
Files/modules this task may touch:
- path/to/file.ts
- path/to/file.test.ts

### Out of Scope
Files/modules explicitly excluded:
- path/to/other.ts (owned by #<issue-number>)

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Test: path/to/test.ts passes

## Context
Anything the agent needs beyond the spec.

## Constraints
What the agent must NOT do.
```

#### Labels

Each issue receives the following labels at creation:

- **Type:** `task:implement` (or `task:refinement` for spec clarification requests)
- **Status:** `status:pending`
- **Priority:** One of `priority:high`, `priority:medium`, `priority:low`

#### Priority Assignment

The Planner assigns priority based on:

- `priority:high` -- Blocks other tasks or is on the critical path. Foundation work (types, core interfaces) that other tasks depend on.
- `priority:medium` -- Default. Standard implementation work with no special urgency.
- `priority:low` -- Nice-to-have, non-blocking, or can be deferred without impacting other work.

#### Dependencies

Dependencies between tasks are documented in two ways:

1. **Issue body:** Include "Blocked by #X" in the Context section when a task cannot start until another completes.
2. **Issue references:** Use GitHub issue references so dependencies are visible in the issue sidebar.

The Planner sequences tasks so that foundational work (types, interfaces, core modules) is created first and marked as `priority:high`, with dependent tasks referencing them.

#### Duplicate Closure

When a new issue supersedes an existing open issue, the Planner closes the existing issue as a duplicate with a comment referencing the new issue number. Duplicate closure happens after new issues are created so that the superseding issue number is available for the reference.

### Phase 5: Report Summary

After all issues are created (or existing issues updated/closed), the Planner outputs a summary as its final text output, returned to whatever process invoked it:

```
## Planning Summary

**Spec:** docs/specs/<name>.md (v<version>)

### Existing Issues
- Closed: #12 (irrelevant), #15 (duplicate of #20)
- Updated: #13 (scope revised)

### New Issues Created
- #20: <title> [priority:high]
- #21: <title> [priority:medium] (blocked by #20)
- #22: <title> [priority:medium] (blocked by #20)
- #23: <title> [priority:low]

### Dependency Graph
#20 → #21
#20 → #22
#21, #22 → #23
```

### Handling Spec Ambiguity

If the Planner encounters ambiguity, contradiction, or a gap in the spec that prevents task decomposition:

1. Do not guess or interpret.
2. Create a `task:refinement` issue using the template below.
3. Do not create tasks that depend on the ambiguous section until the spec is clarified.
4. Continue creating tasks for unambiguous sections of the spec.

#### Refinement Issue Template

```markdown
## Ambiguity

What is ambiguous, contradictory, or missing in the spec.

## Spec Reference
- Spec: `docs/specs/<name>.md`
- Section(s): <relevant sections>
- Quote: "<relevant text from spec>"

## Options
1. **Option A** — description and trade-offs
2. **Option B** — description and trade-offs

## Recommendation
Which option and why.

## Blocked Tasks
Tasks that cannot be created until this is resolved.
```

Refinement issues receive labels `task:refinement`, `status:pending`, and a priority label. Refinement issues default to `priority:high` because they block task creation. Use `priority:medium` only if the ambiguous section does not block critical-path work.

## Acceptance Criteria

- [ ] Given a spec with `status: approved` is committed, when the Planner runs, then it produces GitHub Issues for all unsatisfied acceptance criteria
- [ ] Given a spec with `status` other than `approved`, when the Planner runs, then it stops without creating issues and reports that the spec is not approved
- [ ] Given open `task:refinement` issues exist for a spec, when the Planner runs on that spec, then it stops without creating issues and reports the blocking `task:refinement` issues
- [ ] Given an existing open issue that is superseded by a new issue, when the Planner creates the new issue, then the existing issue is closed as a duplicate with a reference to the new issue number
- [ ] Given existing open issues that reference a removed spec section, when the Planner runs on the updated spec, then those issues are closed with an explanatory comment
- [ ] Given existing open issues with outdated acceptance criteria, when the Planner runs on the updated spec, then those issues are updated to match the current spec
- [ ] Given a new spec with acceptance criteria that the codebase already satisfies, when the Planner runs, then no tasks are created for those criteria
- [ ] Given the Planner creates tasks, when each task issue is inspected, then it contains all required sections: Objective, Spec Reference, Scope (In Scope / Out of Scope), Acceptance Criteria, Context, Constraints
- [ ] Given the Planner creates tasks, when each task issue is inspected, then it has labels `task:implement`, `status:pending`, and exactly one priority label
- [ ] Given two tasks that could touch the same file, when the Planner creates them, then their Scope sections define non-overlapping boundaries
- [ ] Given a task that depends on another task, when the task issue is inspected, then it includes "Blocked by #X" referencing the dependency
- [ ] Given the Planner creates multiple tasks, when the tasks are inspected, then foundational work (types, interfaces, core modules) is marked `priority:high`
- [ ] Given an ambiguous section in the spec, when the Planner encounters it, then it creates a `task:refinement` issue instead of guessing intent
- [ ] Given the Planner creates a `task:refinement` issue, when the issue is inspected, then it has labels `task:refinement`, `status:pending`, and exactly one priority label
- [ ] Given the Planner completes, when the summary is reviewed, then it lists all closed, updated, and newly created issues with their priorities and dependencies

## Dependencies

- skill-github-workflow (for all GitHub operations)
- `gh` CLI (authenticated with repo access)
- Label setup (all workflow labels must exist in the repository; see `script-label-setup.md`)
- Approved specification in `docs/specs/`

## References

- Label definitions: `docs/specs/workflow/script-label-setup.md`
- GitHub Workflow Skill: `docs/specs/workflow/skill-github-workflow.md`
