---
title: Implementor Agent
version: 0.3.1
last_updated: 2026-02-07
status: approved
---

# Implementor Agent

## Overview

Agent that executes assigned tasks by reading task issues and referenced specs, writing code and tests within declared scope, and surfacing blockers when it cannot proceed. An Implementor works on one task at a time; parallelism is achieved by running multiple Implementor instances, not by assigning multiple tasks to one agent.

## Constraints

- Must work on exactly one task at a time.
- Must not modify files outside the task's declared scope, except for incidental changes (see Scope Enforcement).
- Must not make interpretive decisions when the spec is ambiguous, contradictory, or incomplete. Must escalate instead.
- Must not submit partial work as complete. If blocked, must stop, preserve progress, and surface the blocker.
- Must use the `github-workflow` skill for all GitHub operations (label changes, comments, PR creation).
- Must follow the blocker and escalation comment formats defined in this spec.
- Must conform to the project's code style, naming conventions, and patterns defined in `CLAUDE.md`.
- Must not reprioritize tasks or change task sequencing. Executes what is assigned.
- PR branch names must follow the convention `<type>/<issue-number>-<short-description>`.

## Specification

### Trigger

The Implementor agent is invoked with a task issue number when any of the following occur:

1. **New task** -- A Human selects a `status:pending` task for implementation.
2. **Task unblocked** -- A previously blocked task moves to `status:unblocked`.
3. **Task needs changes** -- A reviewed task moves to `status:needs-changes`.

The trigger mechanism is outside the scope of this spec. The agent receives a task issue number as its input and determines the scenario from the task's current status label.

### Inputs

On invocation, the agent reads:

1. **Task issue** -- The GitHub Issue body, including:
   - Objective
   - Spec reference (file path and section names)
   - Scope (In Scope and Out of Scope file lists)
   - Acceptance criteria
   - Context and constraints
2. **Referenced spec sections** -- The spec file(s) and section(s) listed in the task's "Spec Reference" field.
3. **Codebase state** -- The current state of files listed in the "In Scope" section.
4. **Existing PR** (resume only) -- If resuming from `status:unblocked` or `status:needs-changes`, the existing draft PR and its review comments.

### Input Validation

Before starting work, the agent validates its inputs:

1. **Task structure** -- The task issue contains all required sections: Objective, Spec Reference, Scope (with In Scope list), and Acceptance Criteria.
2. **Spec reference** -- The spec file referenced in the task exists and has `status: approved` in its frontmatter.
3. **Status label** -- The task's current status label matches the expected label for the trigger type:
   - `status:pending` for new tasks
   - `status:unblocked` for resumed blocked tasks
   - `status:needs-changes` for post-review tasks
4. **Existing PR** (resume only) -- For `status:unblocked` or `status:needs-changes`, a PR linked to the task issue exists.

If any check fails, the agent stops and adds a comment to the task issue:

```markdown
## Validation Failure

**Check:** <which check failed>
**Expected:** <what was expected>
**Actual:** <what was found>

Cannot proceed until this is resolved.
```

The agent does not change the task's status label on validation failure. It stops and waits for the issue to be corrected.

### Execution Behavior

#### New Task

When invoked with a `status:pending` task:

1. Read the task issue to understand the objective, scope, and acceptance criteria.
2. Read the referenced spec sections to understand the required behavior.
3. Read the current state of in-scope files to understand the baseline.
4. Validate inputs (see Input Validation).
5. Update the task issue label from `status:pending` to `status:in-progress` (via the `github-workflow` skill).
6. Implement and submit (see Complete and Submit).

#### Resume from Unblocked

When a previously blocked task moves to `status:unblocked`:

1. Read the task issue to review the original blocker and any resolution comments.
2. Read the referenced spec sections (which may have been amended).
3. Validate inputs (see Input Validation).
4. Check out the existing draft PR branch.
5. Update the task issue label from `status:unblocked` to `status:in-progress`.
6. Continue implementation from where work was preserved, then complete and submit (see Complete and Submit).

#### Resume from Needs-Changes

When a reviewed task moves to `status:needs-changes`. This scenario does not use the Complete and Submit procedure because it pushes fixes to an existing ready-for-review PR rather than opening or converting one.

1. Read the task issue and PR review comments to understand the requested changes.
2. Read any relevant spec sections referenced in the feedback.
3. Validate inputs (see Input Validation).
4. Check out the existing PR branch.
5. Update the task issue label from `status:needs-changes` to `status:in-progress`.
6. Address each review comment within scope. If a review comment requests changes to out-of-scope files, post an escalation comment explaining the scope constraint and continue with in-scope fixes. Do not open a new PR -- push fixes to the existing one.
7. Update tests if the feedback requires behavioral changes.
8. Verify all tests pass locally. If tests fail, the agent fixes its implementation and re-runs until they pass. If the failure is caused by something outside the agent's scope, treat it as a blocker.
9. Update the task issue label from `status:in-progress` to `status:review`.

#### Complete and Submit

Shared procedure used by all execution scenarios after implementation work is done:

1. Write or update tests that verify each acceptance criterion.
2. Verify all tests pass locally. If tests fail, the agent fixes its implementation and re-runs until they pass. If the failure is caused by something outside the agent's scope (pre-existing failure, broken dependency), treat it as a blocker.
3. Open or update the PR:
   - **New task:** Open a new ready-for-review (non-draft) PR (title: `<type>(<scope>): <description>`, body: `Closes #<issue-number>`, branch: `<type>/<issue-number>-<short-description>`).
   - **Resume from unblocked:** Convert the existing draft PR to ready-for-review.
4. Update the task issue label from `status:in-progress` to `status:review`.

### Blocker Handling

When the agent encounters something that prevents continued progress, it must stop immediately:

1. Stop work on the current task.
2. Open a draft PR to preserve progress made so far (if no PR exists yet).
3. Add a blocker comment to the task issue (see Blocker Comment Format).
4. Update the task issue label from `status:in-progress` to the appropriate status:
   - `status:needs-refinement` for spec blockers (ambiguity, contradiction, gap)
   - `status:blocked` for non-spec blockers (external dependency, technical constraint, scope conflict)

#### Blocker Comment Format

```markdown
## Blocker: <Short Title>

**Type:** spec-ambiguity | spec-contradiction | spec-gap | external-dependency | technical-constraint

**Description:**
Clear explanation of what is blocking progress.

**Spec Reference:**
- File: `docs/specs/<name>.md`
- Section: <section name>
- Quote: "<relevant text from spec>"

**Options:**

1. **<Option A>**
   - Description: ...
   - Trade-offs: ...

2. **<Option B>**
   - Description: ...
   - Trade-offs: ...

**Recommendation:** Option <X> because <reasoning>.

**Impact:** What happens if this isn't resolved (other blocked tasks, timeline impact).
```

The "Spec Reference" section is required for spec blockers (types: `spec-ambiguity`, `spec-contradiction`, `spec-gap`). For non-spec blockers it may be omitted.

At least two options must be provided. A recommendation is required.

#### Escalation Comment Format

When the agent identifies an issue that is not a direct blocker on the current task (e.g., scope conflict with another task, priority conflict, judgment call), it posts an escalation comment and continues working. Escalations do not stop work and do not change the status label. If the issue later prevents progress, it becomes a blocker at that point.

The escalation comment uses this template:

```markdown
## Escalation: <Short Title>

**Type:** scope-conflict | priority-conflict | judgment-call

**Description:**
Clear explanation of the issue.

**What I've Tried:**
Steps taken before escalating.

**Options:**
1. <option> -- <trade-offs>
2. <option> -- <trade-offs>

**Recommendation:** <which option and why, or "No recommendation">

**Blocked Tasks:** <issue references, or "None">

**Decision Needed By:** <date, or "No deadline">
```

### Scope Enforcement

The agent must only modify files listed in the task issue's "In Scope" section, with two exceptions:

1. **Co-located test files** (e.g., `foo.test.ts` adjacent to `foo.ts`) are implicitly in scope, even if not explicitly listed. Shared test utilities, fixtures, and integration tests in other directories are not implicitly in scope.

2. **Incidental changes** to files outside the "In Scope" list are permitted when all of the following are true:
   - The change is minimal (e.g., adding an import, re-exporting a new symbol, adding a field to a shared type, updating test fixtures or snapshots to reflect the structural change).
   - The change is directly required by a change in a primary-scope file (the in-scope change would not work without it).
   - The change does not alter the behavioral logic of the incidentally changed file (e.g., adding a new function, modifying control flow, or changing default values is not incidental).

   Changes that do **not** qualify as incidental include: adding a new function, modifying control flow, changing default values, or adding new test cases for behavior that doesn't yet exist.

If the agent determines that changes outside the declared scope are needed and do not qualify as incidental, it must not modify the out-of-scope files. If the out-of-scope change blocks progress, treat it as a blocker (type: `technical-constraint`). If it does not block progress, post an escalation (type: `scope-conflict`) and continue working.

### Status Transitions

The agent is responsible for the following label transitions (all via the `github-workflow` skill):

| From | To | When |
|------|----|------|
| `status:pending` | `status:in-progress` | Starting work on a new task |
| `status:unblocked` | `status:in-progress` | Resuming a previously blocked task |
| `status:needs-changes` | `status:in-progress` | Resuming after reviewer feedback |
| `status:in-progress` | `status:review` | Work complete, PR ready for review |
| `status:in-progress` | `status:needs-refinement` | Blocked by spec issue |
| `status:in-progress` | `status:blocked` | Blocked by non-spec issue |

The agent must not perform any other status transitions.

### Completion Output

When the agent finishes (whether successfully or stopped by a validation failure or blocker), it outputs a summary as its final text output (returned to whatever process invoked it):

```
## Implementor Result

**Task:** #<issue-number> — <title>
**Outcome:** completed | blocked | validation-failure
**PR:** #<pr-number> (or "None")

### What Was Done
Brief description of changes made (or "No changes" if stopped before implementation).

### Outstanding
Any unresolved items, blocker references, or follow-up needed.
```

## Acceptance Criteria

- [ ] Given the agent is invoked with a `status:pending` task, when it starts work, then the task label is updated to `status:in-progress` before any code changes are made.
- [ ] Given a task issue with a "Spec Reference" field, when the agent starts work, then it reads the referenced spec file and sections before writing code.
- [ ] Given a task issue missing a required section (Objective, Spec Reference, Scope, or Acceptance Criteria), when the agent validates inputs, then it posts a validation failure comment and stops without changing the status label.
- [ ] Given a task issue whose referenced spec file does not exist or is not `status: approved`, when the agent validates inputs, then it posts a validation failure comment and stops without changing the status label.
- [ ] Given a task with an "In Scope" file list, when the agent completes work, then only files in the "In Scope" list, their co-located test files, and any incidental changes (minimal, directly required, non-behavioral) have been modified.
- [ ] Given a task whose acceptance criteria are all satisfiable, when the agent completes work, then a PR exists that is linked to the task issue via `Closes #<issue-number>`.
- [ ] Given a task whose acceptance criteria are all satisfiable, when the agent completes work, then all tests pass locally before the label is changed to `status:review`.
- [ ] Given the agent encounters a spec ambiguity during implementation, when it stops work, then a draft PR is opened, a blocker comment following the blocker format is added to the issue, and the task label is set to `status:needs-refinement`.
- [ ] Given the agent encounters a non-spec blocker during implementation, when it stops work, then a draft PR is opened, a blocker comment following the blocker format is added to the issue, and the task label is set to `status:blocked`.
- [ ] Given a blocker comment posted by the agent, when reviewed, then it contains a Type field, a Description, at least two Options with trade-offs, and a Recommendation.
- [ ] Given a spec blocker comment posted by the agent, when reviewed, then it includes a Spec Reference section with file path, section name, and quote. Given a non-spec blocker comment, the Spec Reference section may be omitted.
- [ ] Given a task that moves to `status:unblocked`, when the agent resumes, then it checks out the existing draft PR branch and continues from preserved progress rather than starting over.
- [ ] Given a task that moves to `status:unblocked`, when the agent completes work, then the existing draft PR is converted to ready-for-review rather than opening a new PR.
- [ ] Given a task that moves to `status:needs-changes`, when the agent resumes, then it pushes fixes to the existing PR branch rather than opening a new PR.
- [ ] Given a task that moves to `status:needs-changes`, when a review comment requests changes to out-of-scope files, then the agent posts an escalation comment explaining the scope constraint and continues with in-scope fixes.
- [ ] Given any status transition performed by the agent, when reviewed, then it matches one of the six defined transitions in the Status Transitions table.
- [ ] Given the agent identifies a non-blocking issue (e.g., scope conflict with another task), when it posts an escalation comment, then it continues working and does not change the status label.
- [ ] Given a completed PR, when reviewed, then the branch name follows the `<type>/<issue-number>-<short-description>` convention.
- [ ] Given the agent finishes execution (any outcome), when reviewed, then it has returned a completion summary with the task number, outcome, PR reference, and description of what was done.

## Dependencies

- `github-workflow` skill -- All GitHub operations (label changes, issue comments, PR creation and updates).
- `gh` CLI -- Authenticated via `scripts/workflow/gh.sh` wrapper (see `github-cli.md`).
- Project testing framework -- Tests must be runnable locally via the commands defined in `CLAUDE.md`.
- `CLAUDE.md` -- Code style, naming conventions, and patterns that the agent must conform to.

## References

- `docs/specs/workflow/skill-github-workflow.md` -- GitHub Workflow Skill spec (operations, label transitions, query patterns)
- `docs/specs/workflow/github-cli.md` -- GitHub CLI wrapper spec
- `docs/specs/workflow/script-label-setup.md` -- Label definitions for the repository
