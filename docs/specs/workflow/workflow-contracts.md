---
title: Workflow Contracts
version: 0.4.0
last_updated: 2026-02-12
status: approved
---

# Workflow Contracts

## Overview

Shared data formats and templates used across workflow agents. Each template is defined once here
and referenced by the agent specs that produce or consume it.

## Constraints

- This spec is the single source of truth for all workflow output formats — agent definitions
  reference these templates via cross-references, not inline copies
- Agent definitions inline the templates they use at build time — agents do not fetch templates via
  tool calls at runtime
- Every template must include all required fields; optional fields must be explicitly marked as
  optional
- Template changes require a version bump in this spec and updates to all consuming agent specs
- Format consistency across agents: all comment templates use markdown with the same heading
  hierarchy and field structure

## Specification

### Completion Output Formats

#### Implementor Completion Output

Produced by the Implementor as its final text output, returned to the invoking process.

```
## Implementor Result

**Task:** #<issue-number> — <title>
**Outcome:** completed | blocked | validation-failure
**PR:** #<pr-number> | None (only valid when outcome is `blocked` or `validation-failure`)

### What Was Done
Brief description of changes made (or "No changes" if stopped before implementation).

### Outstanding
Any unresolved items, blocker references, or follow-up needed.
```

#### Reviewer Completion Output

Produced by the Reviewer as its final text output, returned to the invoking process.

```
## Reviewer Result

**Task:** #<issue-number> — <title>
**Outcome:** approved | needs-changes
**PR:** #<pr-number>

### Summary
Brief description of the review result. For approvals, confirm what was verified. For rejections, list the categories with findings.
```

#### Planning Summary Format

Produced by the Planner as its final text output, returned to the invoking process. When multiple
specs are processed, includes per-spec sections with a combined dependency graph.

```
## Planning Summary

### docs/specs/<name-1>.md (v<version>)

#### Existing Issues
- Closed: #12 (irrelevant), #15 (duplicate of #20)
- Updated: #13 (scope revised)

#### New Issues Created
- #20: <title> [priority:high]
- #21: <title> [priority:medium] (blocked by #20)

### docs/specs/<name-2>.md (v<version>)

#### Existing Issues
- (none)

#### New Issues Created
- #22: <title> [priority:medium] (blocked by #20)
- #23: <title> [priority:low]

### Combined Dependency Graph
#20 → #21
#20 → #22
#21, #22 → #23
```

### Issue Comment Formats

#### Validation Failure Comment

Posted to the task issue when an agent's input validation fails. The agent stops without changing
the status label.

```markdown
## Validation Failure

**Check:** <which check failed> **Expected:** <what was expected> **Actual:** <what was found>

Cannot proceed until this is resolved.
```

#### Blocker Comment Format

Posted to the task issue by the Implementor when it encounters something that prevents continued
progress. The agent stops work, preserves progress in a draft PR, and transitions the task to
`status:needs-refinement` (spec blockers) or `status:blocked` (non-spec blockers).

Requirements:

- At least two options must be provided.
- A recommendation is required.
- The "Spec Reference" section is required for spec blockers (types: `spec-ambiguity`,
  `spec-contradiction`, `spec-gap`). For non-spec blockers it may be omitted.

```markdown
## Blocker: <Short Title>

**Type:** spec-ambiguity | spec-contradiction | spec-gap | external-dependency |
technical-constraint

**Description:** Clear explanation of what is blocking progress.

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

#### Escalation Comment Format

Posted to the task issue by the Implementor when it identifies a non-blocking issue (e.g., scope
conflict, priority conflict, judgment call). The agent continues working and does not change the
status label.

```markdown
## Escalation: <Short Title>

**Type:** scope-conflict | priority-conflict | judgment-call

**Description:** Clear explanation of the issue.

**What I've Tried:** Steps taken before escalating.

**Options:**

1. <option> -- <trade-offs>
2. <option> -- <trade-offs>

**Recommendation:** <which option and why, or "No recommendation">

**Blocked Tasks:** <issue references, or "None">

**Decision Needed By:** <date, or "No deadline">
```

### PR Review Formats

#### Review Approval Template

Submitted as a PR review comment by the Reviewer when all review checklist steps pass (no findings
recorded).

```markdown
## Review: Approved

### Checklist

- **Unresolved Comments:** No outstanding items (or N/A)
- **Scope Compliance:** All modified files within scope
- **Task Constraints:** All constraints satisfied
- **Acceptance Criteria:** All N criteria verified
- **Spec Conformance:** Implementation matches spec
- **Code Quality:** Consistent with project standards

### Warnings

<any warnings from skipped steps or scope observations, or "None">
```

#### Review Rejection Template

Submitted as a PR review comment by the Reviewer when one or more review checklist steps have
findings. Only categories with findings are included. Each piece of feedback must include all three
fields (What, Why, Fix).

```markdown
## Review: Needs Changes

### Findings

#### <Category>

- **What:** <specific file, line, or criterion> **Why:** <reference to spec, convention, or
  criterion> **Fix:** <concrete, actionable guidance>

### Warnings

<any warnings from skipped steps or scope observations, or "None">
```

### GitHub Issue Templates

#### Task Issue Template

Created by the Planner for each implementation task. Consumed by the Implementor (reads the issue to
understand its assignment) and the Reviewer (reads the issue to evaluate the PR against).

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

Labels at creation:

- **Type:** `task:implement`
- **Status:** `status:pending`
- **Priority:** One of `priority:high`, `priority:medium`, `priority:low`
- **Complexity:** One of `complexity:simple`, `complexity:complex`

#### Refinement Issue Template

Created by the Planner when it encounters ambiguity, contradiction, or a gap in a spec that prevents
task decomposition. Refinement issues do not receive a complexity label.

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

Labels at creation:

- **Type:** `task:refinement`
- **Status:** `status:pending`
- **Priority:** One of `priority:high` (default — blocks task creation), `priority:medium` (only if
  the ambiguous section does not block critical-path work)

#### Planning Gate Failure Format

Output by the Planner when a spec fails pre-planning validation gates. One block per failed spec.

```
## Planning Gate Failure

**Spec:** docs/specs/<name>.md

### Failed Gates
- Gate 1: Spec status is `<actual status>` (required: `approved`)
- Gate 4: Open `task:refinement` issues: #12, #15

### Action Required
What must be resolved before the Planner can process this spec.
```

### Scope Enforcement Rules

These rules govern what files an agent may modify. They are referenced by the Implementor (which
enforces them during implementation) and the Reviewer (which audits compliance during review).

1. **Primary scope:** Files listed in the task issue's "In Scope" section. No restrictions on the
   nature or size of changes.

2. **Co-located test files:** Test files adjacent to in-scope files (e.g., `foo.test.ts` next to
   `foo.ts`) are implicitly in scope, even if not explicitly listed. Shared test utilities,
   fixtures, and integration tests in other directories are not implicitly in scope.

3. **Incidental changes:** Files not listed in "In Scope" but modified as a necessary consequence of
   in-scope work. A change qualifies as incidental when all of the following are true:
   - The change is minimal (e.g., adding an import, re-exporting a new symbol, adding a field to a
     shared type, updating test fixtures or snapshots to reflect the structural change).
   - The change is directly required by a change in a primary-scope file (the in-scope change would
     not work without it).
   - The change does not alter the behavioral logic of the incidentally changed file.

   Changes that do **not** qualify as incidental include: adding a new function, modifying control
   flow, changing default values, or adding new test cases for behavior that doesn't yet exist.

4. **Scope inaccuracy:** When the In Scope list names a file that does not contain the expected code
   (e.g., the task describes modifying a handler in file A, but the handler actually lives in file
   B), the agent determines the correct target file from the codebase and treats it as the effective
   primary scope. The agent documents the discrepancy in the PR body using a "Scope correction"
   section:

   ```
   ## Scope correction
   - **Listed:** `<file from In Scope list>`
   - **Actual:** `<correct file>`
   - **Reason:** <why the listed file is wrong and the actual file is correct>
   ```

   This rule applies when the task intent is unambiguous and the correct target is identifiable from
   reading the code. If the discrepancy makes the task intent unclear, the agent treats it as a
   blocker (type: `spec-gap`).

When a file outside scope needs non-incidental changes:

- **Implementor:** Treats it as a blocker (type: `technical-constraint`) if it blocks progress, or
  an escalation (type: `scope-conflict`) if it does not.
- **Reviewer:** Records it as a warning (does not trigger rejection).

## Acceptance Criteria

- [ ] Given a completion output template, when inspected, then it contains all required fields
      (Task, Outcome, PR) with no optional fields left undefined.
- [ ] Given a blocker comment, when the type is a spec blocker (`spec-ambiguity`,
      `spec-contradiction`, `spec-gap`), then the Spec Reference section is present with File,
      Section, and Quote fields.
- [ ] Given a blocker comment, when the type is a non-spec blocker (`external-dependency`,
      `technical-constraint`), then the Spec Reference section may be omitted without invalidating
      the comment.
- [ ] Given a blocker comment, when inspected, then it contains at least two options and a
      recommendation.
- [ ] Given a review rejection comment, when inspected, then every finding includes all three fields
      (What, Why, Fix) and only categories with findings are included.
- [ ] Given a task issue created from the template, when inspected, then it has labels from all four
      categories: type, status, priority, and complexity.
- [ ] Given a refinement issue created from the template, when inspected, then it does not have a
      complexity label.
- [ ] Given a planning gate failure output, when multiple specs fail validation, then each failed
      spec has its own block with specific failed gates and required actions.
- [ ] Given a scope enforcement decision, when a change qualifies under all three incidental-change
      criteria, then it is permitted without listing the file in "In Scope".
- [ ] Given a scope enforcement decision, when a change fails any one of the three incidental-change
      criteria, then the Implementor treats it as a blocker or escalation (not a silent
      modification).
- [ ] Given a task whose In Scope list names a file that does not contain the expected code, when
      the correct target is identifiable from reading the codebase and the task intent is
      unambiguous, then the agent treats the correct file as effective primary scope and documents
      the discrepancy in the PR body.
- [ ] Given a task whose In Scope list names a file that does not contain the expected code, when
      the discrepancy makes the task intent unclear, then the agent treats it as a blocker (type:
      `spec-gap`).

## Dependencies

- [workflow.md](./workflow.md) -- status labels, label taxonomy, lifecycle phases, and quality gates
  referenced by templates
- [agent-planner.md](./agent-planner.md) -- consumes task issue template, refinement issue template,
  and planning summary format
- [agent-implementor.md](./agent-implementor.md) -- consumes completion output, blocker comment,
  escalation comment, and scope enforcement rules
- [agent-reviewer.md](./agent-reviewer.md) -- consumes review approval template, review rejection
  template, and scope enforcement rules
- [script-label-setup.md](./script-label-setup.md) -- label definitions (names, descriptions,
  colors) used in issue templates

## References

- `docs/specs/workflow/workflow.md`
- `docs/specs/workflow/agent-planner.md`
- `docs/specs/workflow/agent-implementor.md`
- `docs/specs/workflow/agent-reviewer.md`
- `docs/specs/workflow/script-label-setup.md`
- `docs/specs/workflow/skill-agent-spec-writing.md`
