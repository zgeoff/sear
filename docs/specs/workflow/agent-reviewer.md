---
title: Reviewer Agent
version: 0.3.3
last_updated: 2026-02-09
status: approved
---

# Reviewer Agent

## Overview

Agent that reviews completed implementation work against acceptance criteria, spec conformance, code quality, and scope boundaries before integration. The Reviewer either approves the work for Human integration or rejects it with actionable feedback for the Implementor to address. The Reviewer never merges -- that is the Human's responsibility.

## Constraints

- Must not merge PRs. Approval means setting `status:approved`; the Human performs the merge.
- Must never reject without providing actionable feedback explaining what needs to change and why.
- Must use the `github-workflow` skill for the mechanics of all GitHub operations (command syntax, authentication, label rules, templates). This spec's workflow steps define **when** to perform operations; the skill defines **how** to execute them.
- Must verify all acceptance criteria from the task issue, not a subset.
- Must verify scope compliance -- PR changes must stay within the task's primary scope or qualify as incidental changes (see Scope Compliance).
- Must verify tests pass before approving.
- Must not modify code. The Reviewer reads and evaluates; it does not fix.
- Must run the full review checklist on every review. Individual checklist failures do not short-circuit the remaining steps.

## Specification

### Trigger

The Reviewer agent is invoked when a task issue moves to `status:review`.

### Inputs

On invocation, the agent reads:

1. **Task issue** -- The GitHub Issue body, including:
   - Objective
   - Spec reference (file path and section names)
   - Scope (In Scope and Out of Scope file lists)
   - Acceptance criteria
   - Constraints
2. **PR diff** -- The pull request linked to the task issue, including all changed files.
3. **Referenced spec sections** -- The spec file(s) and section(s) listed in the task's "Spec Reference" field.
4. **CI status** -- The CI pipeline results for the PR, fetched via the `github-workflow` skill (`gh pr checks`).
5. **PR review comments** -- All review comments on the PR from any source (prior Reviewer runs, Human reviewers, etc.), to verify that existing feedback has been addressed.

### Input Validation

Before running the review checklist, the agent validates its inputs:

1. **Task structure** -- The task issue contains all required sections: Objective, Spec Reference, Scope (with In Scope list), and Acceptance Criteria.
2. **Status label** -- The task issue has the `status:review` label.
3. **Linked PR** -- A PR linked to the task issue exists (search for `Closes #<N>` or GitHub link). The PR is not in draft state and has no merge conflicts.
4. **CI completed** -- CI has finished running (status is not pending). The result (pass or fail) is evaluated during the review checklist, not here.
5. **Spec reference** -- The spec file referenced in the task exists and has `status: approved` in its frontmatter.

Merge conflicts are a validation failure because the PR cannot be reviewed in a meaningful state — the Implementor must resolve conflicts before review can proceed.

If any check fails, the agent posts a comment to the task issue explaining what is missing:

```markdown
## Review Validation Failure

**Check:** <which check failed>
**Expected:** <what was expected>
**Actual:** <what was found>

Cannot proceed with review until this is resolved.
```

The agent does not change the task's status label on validation failure. It stops and waits for the issue to be corrected before re-invocation.

### Review Checklist

The agent evaluates the PR against each of the following criteria. All steps run on every review -- individual failures do not short-circuit the remaining steps. Findings from all steps are collected and delivered in a single review comment.

#### 1. CI Results

- Check the CI pipeline results via the `github-workflow` skill.
- If any tests fail, record the failing test names and details as a finding.
- CI failure guarantees rejection but does not stop the review -- remaining steps still run.

#### 2. Unresolved Review Comments

This step applies when any review comments exist on the PR from human or agent sources (prior Reviewer runs, Human reviewers, or other contributors). Automated bot comments (linters, CI status checks, security scanners) are excluded.

- Review each piece of feedback on the PR from human and agent sources.
- Verify that each previously raised issue has been addressed. A comment is considered addressed when either the code has been changed to resolve the issue, or the author has replied explaining why no change is needed.
- If any feedback is unaddressed, record which items remain outstanding and their source.

#### 3. Scope Compliance

Compare the list of files modified in the PR diff against the task issue's scope:

- **Primary scope:** Files listed in the task's "In Scope" section. All implementation work should live here. No restrictions on the nature or size of changes to these files.
- **Co-located test files:** Test files adjacent to in-scope files (e.g., `foo.test.ts` next to `foo.ts`) are implicitly in scope, even if not explicitly listed. Shared test utilities, fixtures, and integration tests in other directories are not implicitly in scope.
- **Incidental changes:** Files not listed in "In Scope" but modified as a necessary consequence of in-scope work. A change qualifies as incidental when all of the following are true:
  - It is minimal (e.g., adding an import, re-exporting a new symbol, adding a field to a shared type, updating test fixtures or snapshots to reflect the structural change).
  - It is directly required by a change in a primary-scope file (the in-scope change would not work without it).
  - It does not alter the behavioral logic of the incidentally changed file.

  Changes that do **not** qualify as incidental include: adding a new function, modifying control flow, changing default values, or adding new test cases for behavior that doesn't yet exist.

If a modified file is neither in primary scope nor qualifies as an incidental change, record it as a scope violation with an explanation of why it does not qualify.

#### 4. Acceptance Criteria Verification

- For each acceptance criterion in the task issue, verify that the implementation satisfies it.
- Check that tests exist which exercise each criterion.
- Record a per-criterion breakdown: which criteria passed, which failed, and an explanation for each failure.

#### 5. Spec Conformance

- Read the referenced spec sections and compare the implementation behavior against the specified behavior.
- Verify that the implementation does not contradict, omit, or extend beyond what the spec requires.
- If a deviation is found, record the specific spec file, section, and a description of the deviation.

#### 6. Code Quality and Consistency

- Verify code follows the project's style, naming conventions, and patterns defined in `CLAUDE.md`.
- Check for readability and maintainability -- code should be understandable without requiring the author to explain it.
- Verify consistency with existing codebase patterns (e.g., similar modules should follow similar structure).
- Check for common issues: missing error handling at system boundaries, potential security vulnerabilities, unnecessary complexity.
- If quality issues are found, record specific file paths, line references, and suggested improvements.

#### 7. PR Conventions

- Verify the PR title follows `<type>(<scope>): <description>`.
- Verify the PR body contains `Closes #<issue-number>`.
- Verify the branch name follows `<type>/<issue-number>-<short-description>`.
- Convention violations are findings that contribute to rejection, like any other checklist step.

### Approval Flow

When all review checklist steps pass (no findings recorded):

1. Submit a PR review comment via the `github-workflow` skill (`gh pr review --comment`) with a summary confirming what was verified.
2. Update the task issue label from `status:review` to `status:approved` (via the `github-workflow` skill). The label is the canonical approval signal.

### Rejection Flow

When one or more review checklist steps have findings:

1. Submit a PR review comment via the `github-workflow` skill (`gh pr review --comment`) with actionable feedback structured by checklist category (CI results, unresolved comments, scope, acceptance criteria, spec conformance, code quality, PR conventions). Only categories with findings are included.
2. Each piece of feedback must include:
   - What is wrong (specific file, line, or criterion).
   - Why it is wrong (reference to spec, convention, or criterion).
   - What needs to change (concrete, actionable guidance).
3. Update the task issue label from `status:review` to `status:needs-changes` (via the `github-workflow` skill).

### Status Transitions

The agent is responsible for the following label transitions (all via the `github-workflow` skill):

| From | To | When |
|------|----|------|
| `status:review` | `status:approved` | All review checklist steps pass |
| `status:review` | `status:needs-changes` | One or more review checklist steps have findings |

The agent must not perform any other status transitions.

### Completion Output

When the agent finishes (whether with an approval, rejection, or validation failure), it returns a summary to the invoking process:

```
## Reviewer Result

**Task:** #<issue-number> — <title>
**Outcome:** approved | needs-changes | validation-failure
**PR:** #<pr-number> (or "None")

### Summary
Brief description of the review result. For approvals, confirm what was verified. For rejections, list the categories with findings. For validation failures, state which input check failed.
```

## Acceptance Criteria

- [ ] Given a task issue with `status:review` and a linked PR, when the agent is invoked, then it validates inputs before running the review checklist.
- [ ] Given a task issue missing a required section, when the agent validates inputs, then it posts a validation failure comment and stops without changing the status label.
- [ ] Given a PR with no completed CI run, when the agent validates inputs, then it posts a validation failure comment and stops without changing the status label.
- [ ] Given a PR with merge conflicts, when the agent validates inputs, then it posts a validation failure comment and stops without changing the status label.
- [ ] Given a referenced spec file that does not exist or is not `status: approved`, when the agent validates inputs, then it posts a validation failure comment and stops without changing the status label.
- [ ] Given a PR where CI tests fail, when the agent reviews it, then the full review checklist still runs and the rejection feedback includes the failing test details alongside any other findings.
- [ ] Given a PR with unresolved review comments from any source (prior Reviewer runs, Human reviewers), when the agent reviews it, then it verifies each comment has been addressed and records unaddressed items as findings.
- [ ] Given a PR that modifies files outside the task's "In Scope" list, when the modification qualifies as an incidental change (minimal, directly required, non-behavioral), then the Reviewer does not flag it as a scope violation.
- [ ] Given a PR that modifies files outside the task's "In Scope" list, when the modification does not qualify as incidental, then the Reviewer rejects with the out-of-scope files listed and an explanation of why they don't qualify.
- [ ] Given a PR that satisfies all checklist steps (CI passes, no unresolved comments, scope compliant, all acceptance criteria met, spec conformant, code quality approved, conventions followed), when the agent reviews it, then the task label is updated to `status:approved` and a PR review comment is submitted confirming the approval.
- [ ] Given a PR that fails one or more acceptance criteria, when the agent reviews it, then the rejection feedback includes a per-criterion breakdown indicating which passed and which failed.
- [ ] Given the agent rejects a PR, when the review is examined, then each piece of feedback includes what is wrong, why it is wrong, and what needs to change.
- [ ] Given the agent rejects a PR, when the review is examined, then the task label is `status:needs-changes` and a PR review comment has been submitted with actionable feedback.
- [ ] Given a PR with a spec deviation, when the agent rejects it, then the feedback references the specific spec file and section where the deviation was found.
- [ ] Given any status transition performed by the agent, when reviewed, then it is either `status:review` to `status:approved` or `status:review` to `status:needs-changes`.
- [ ] Given the agent finishes execution (any outcome), when reviewed, then it has returned a completion summary with the task number, outcome, PR reference, and summary of results.

## Dependencies

- `github-workflow` skill -- All GitHub operations (label changes, issue comments, CI status checks, PR reviews).
- `gh` CLI -- Authenticated via `scripts/workflow/gh.sh` wrapper (see `github-cli.md`).
- `CLAUDE.md` -- Code style, naming conventions, and patterns that the agent checks against.
- Agent Bash Tool Validator (`scripts/workflow/validate-bash.sh`) -- PreToolUse hook that validates all Bash commands against blocklist/allowlist before execution. Required with `permissionMode: bypassPermissions`. See `agent-hook-bash-validator.md` (rules) and `agent-hook-bash-validator-script.md` (shell implementation).

## References

- `docs/specs/workflow/workflow.md` -- Development Protocol (Reviewer role, Review Phase, Quality Gates for Review to Integrate)
- `docs/specs/workflow/skill-github-workflow.md` -- GitHub Workflow Skill spec (operations, label transitions, query patterns)
- `docs/specs/workflow/github-cli.md` -- GitHub CLI wrapper spec
- `docs/specs/workflow/script-label-setup.md` -- Label definitions for the repository
