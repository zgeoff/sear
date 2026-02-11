---
title: Reviewer Agent
version: 0.5.1
last_updated: 2026-02-11
status: approved
---

# Reviewer Agent

## Overview

Agent that reviews completed implementation work against acceptance criteria, spec conformance, code quality, and scope boundaries before integration. The Reviewer either approves the work for Human integration or rejects it with actionable feedback for the Implementor to address. The Reviewer never merges -- that is the Human's responsibility.

## Constraints

- Must not merge PRs. Approval means setting `status:approved`.
- Must never reject without providing actionable feedback explaining what needs to change and why.
- Must use `scripts/workflow/gh.sh` for all GitHub CLI operations (see `skill-github-workflow.md` § Authentication for wrapper behavior).
- Scope issues are reported as warnings, not as findings that trigger rejection.

## Agent Definition Frontmatter

The agent definition file for the Reviewer must include the following frontmatter fields (see `control-plane-engine-agent-manager.md` § Frontmatter Field Mapping for how the Engine parses these):

```yaml
name: reviewer
description: Reviews PRs against acceptance criteria, spec conformance, and code quality
model: sonnet
maxTurns: 50
tools: Read, Grep, Glob, Bash
disallowedTools: Write, Edit, NotebookEdit, WebFetch, WebSearch, Task, TaskOutput, EnterPlanMode, ExitPlanMode, AskUserQuestion, TodoWrite, Skill
permissionMode: bypassPermissions
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: scripts/workflow/validate-bash.sh
```

- **name:** Agent identifier used by the engine for dispatch and logging.
- **description:** One-line summary mapped to `AgentDefinition.description`.
- **model:** `sonnet` — the Reviewer performs read-only analysis; Sonnet is sufficient.
- **maxTurns:** `50` — upper bound on agentic turns per session.
- **tools:** Allowlist. The Reviewer reads code and runs checks but never modifies files.
- **disallowedTools:** Denylist reinforcing the allowlist. Blocks write operations, web access, sub-agent spawning, plan mode, user interaction, and todo list management.
- **permissionMode:** `bypassPermissions` — agents run non-interactively. The engine overrides this at dispatch time, but including it ensures correct behavior when the agent is run directly via CLI.
- **hooks:** PreToolUse bash validator hook. The engine provides this programmatically at dispatch time (see `control-plane-engine-agent-manager.md` § Programmatic Hooks), but including it ensures the validator is active when the agent is run directly via CLI.

## Specification

### Trigger

The Reviewer agent is invoked with a task issue number when the task has `status:review` (see `control-plane-engine.md` § Completion-dispatch for trigger mechanism).

### Inputs

The Engine injects the following into the agent's session at dispatch time (see `control-plane-engine-agent-manager.md` § Trigger Context and § Project Context Injection):

1. **Trigger prompt:** The task issue number (e.g., `"42"`).
2. **Project context:** CLAUDE.md content (coding conventions, style rules, architecture) appended to the agent's system prompt.

The agent fetches all remaining data via tool calls. On invocation, the agent reads:

1. **Task issue** -- The GitHub Issue body, including:
   - Objective
   - Spec reference (file path and section names)
   - Scope (In Scope file list)
   - Acceptance criteria
   - Constraints
2. **PR diff** -- The pull request linked to the task issue, including all changed files.
3. **Referenced spec sections** -- The spec file(s) and section(s) listed in the task's "Spec Reference" field.
4. **PR review comments** -- All review comments on the PR from any source (prior Reviewer runs, Human reviewers, etc.), to verify that existing feedback has been addressed.

### Input Validation

Before running the review checklist, the agent validates that an open PR linked to the task issue exists (search for `Closes #<N>` or GitHub link). Without a PR there is no diff to review.

If no linked open PR is found, the agent posts a comment to the task issue:

```markdown
## Review Validation Failure

No open PR linked to this task issue was found. The Reviewer requires a PR to review.
```

The agent does not change the task's status label on validation failure. It stops and waits for the issue to be corrected before re-invocation.

### Review Checklist

The agent evaluates the PR against each of the following criteria. All steps run on every review -- individual failures do not short-circuit the remaining steps. Findings from all steps are collected and delivered in a single review comment.

If a step's required input is missing (e.g., no Scope section for scope compliance, no Spec Reference for spec conformance, spec file does not exist or is not `status: approved`), the agent records a warning for that step noting what is missing and proceeds to the next step. Missing inputs do not block the review -- the agent reviews what it can and reports what it cannot.

Warnings are not findings. A warning indicates a step was skipped due to missing input or a scope observation; a finding indicates a problem with the code. Warnings do not count toward the approval/rejection decision. The PR review comment includes any warnings alongside findings so the reader has full visibility into what was and was not checked.

#### 1. Unresolved Review Comments

This step applies when any review comments exist on the PR from non-automated sources (prior Reviewer runs, other reviewers, or other contributors). Automated bot comments (linters, CI status checks, security scanners) are excluded.

- Review each piece of feedback on the PR from non-automated sources.
- Verify that each previously raised issue has been addressed. A comment is considered addressed when either the code has been changed to resolve the issue, or the author has replied explaining why no change is needed.
- If any feedback is unaddressed, record which items remain outstanding and their source.

#### 2. Scope Compliance

Compare the list of files modified in the PR diff against the task issue's scope:

- **Primary scope:** Files listed in the task's "In Scope" section. All implementation work is expected to live here. No restrictions on the nature or size of changes to these files.
- **Co-located test files:** Test files adjacent to in-scope files (e.g., `foo.test.ts` next to `foo.ts`) are implicitly in scope, even if not explicitly listed. Shared test utilities, fixtures, and integration tests in other directories are not implicitly in scope.
- **Incidental changes:** Files not listed in "In Scope" but modified as a necessary consequence of in-scope work. A change qualifies as incidental when all of the following are true:
  - It is minimal (e.g., adding an import, re-exporting a new symbol, adding a field to a shared type, updating test fixtures or snapshots to reflect the structural change).
  - It is directly required by a change in a primary-scope file (the in-scope change would not work without it).
  - It does not alter the behavioral logic of the incidentally changed file.

  Changes that do **not** qualify as incidental include: adding a new function, modifying control flow, changing default values, or adding new test cases for behavior that doesn't yet exist.

If a modified file is neither in primary scope nor qualifies as an incidental change, record it as a warning with an explanation of why it does not appear to qualify.

#### 3. Task Constraints

- If the task issue includes a "Constraints" section, verify that the implementation honors each constraint. If the section is absent, record a warning and proceed.
- Record a per-constraint breakdown: which constraints were satisfied and which were violated, with an explanation for each violation.

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

### Approval Flow

When all review checklist steps pass (no findings recorded):

1. Submit a PR review comment (`scripts/workflow/gh.sh pr review --comment`) using the approval template:

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

2. Update the task issue label from `status:review` to `status:approved` (`scripts/workflow/gh.sh issue edit`). The label is the canonical approval signal.

### Rejection Flow

When one or more review checklist steps have findings:

1. Submit a PR review comment (`scripts/workflow/gh.sh pr review --comment`) using the rejection template:

   ```markdown
   ## Review: Needs Changes

   ### Findings

   #### <Category>
   - **What:** <specific file, line, or criterion>
     **Why:** <reference to spec, convention, or criterion>
     **Fix:** <concrete, actionable guidance>

   ### Warnings
   <any warnings from skipped steps or scope observations, or "None">
   ```

   Only categories with findings are included. Each piece of feedback must include all three fields (What, Why, Fix). Warnings from skipped steps and scope analysis are listed separately.

2. Update the task issue label from `status:review` to `status:needs-changes` (`scripts/workflow/gh.sh issue edit`).

### Status Transitions

The agent is responsible for the following label transitions (all via `scripts/workflow/gh.sh`):

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

- [ ] Given a task issue with a linked open PR, when the agent is invoked, then it validates the PR exists before running the review checklist.
- [ ] Given no open PR linked to the task issue, when the agent validates inputs, then it posts a validation failure comment and stops without changing the status label.
- [ ] Given a task issue missing a required section (Scope, Acceptance Criteria, or Spec Reference), when the agent reviews the PR, then the review includes a warning for each affected checklist step and the remaining steps still run.
- [ ] Given a referenced spec file that does not exist or is not `status: approved`, when the agent reviews the PR, then the spec conformance step records a warning and the remaining steps still run.
- [ ] Given a PR with unresolved review comments from any non-automated source (prior Reviewer runs, other reviewers), when the agent reviews it, then it verifies each comment has been addressed and records unaddressed items as findings.
- [ ] Given a PR that modifies files outside the task's "In Scope" list, when the modification qualifies as an incidental change (minimal, directly required, non-behavioral), then the Reviewer does not flag it as a scope warning.
- [ ] Given a PR that modifies files outside the task's "In Scope" list, when the modification does not qualify as incidental, then the Reviewer records a scope warning listing the files and an explanation of why they don't appear to qualify. The warning does not trigger rejection.
- [ ] Given a PR that satisfies all checklist steps (no unresolved comments, task constraints honored, all acceptance criteria met, spec conformant, code quality approved), when the agent reviews it, then the task label is updated to `status:approved` and a PR review comment is submitted confirming the approval.
- [ ] Given a PR that fails one or more acceptance criteria, when the agent reviews it, then the rejection feedback includes a per-criterion breakdown indicating which passed and which failed.
- [ ] Given the agent rejects a PR, when the review is examined, then each piece of feedback includes what is wrong, why it is wrong, and what needs to change.
- [ ] Given the agent rejects a PR, when the review is examined, then the task label is `status:needs-changes` and a PR review comment has been submitted with actionable feedback.
- [ ] Given a PR with a spec deviation, when the agent rejects it, then the feedback references the specific spec file and section where the deviation was found.
- [ ] Given a PR that violates a task constraint, when the agent reviews it, then the rejection feedback identifies the constraint and explains how the implementation violates it.
- [ ] Given a PR with code quality issues (style violations, missing error handling at system boundaries, unnecessary complexity), when the agent reviews it, then the rejection feedback references specific files and lines with suggested improvements.
- [ ] Given any status transition performed by the agent, when reviewed, then it is either `status:review` to `status:approved` or `status:review` to `status:needs-changes`.
- [ ] Given the agent finishes execution (any outcome), when reviewed, then it has returned a completion summary with the task number, outcome, PR reference, and summary of results.
- [ ] Given any GitHub CLI operation performed by the Reviewer, when the command is inspected, then it uses `scripts/workflow/gh.sh` (not bare `gh`).

## Dependencies

- `scripts/workflow/gh.sh` -- Authenticated `gh` CLI wrapper (see `docs/specs/workflow/github-cli.md`). All GitHub operations (label changes, issue comments, PR reviews).
- `CLAUDE.md` -- Code style, naming conventions, and patterns that the agent checks against.
- Agent Bash Tool Validator — PreToolUse hook that validates all Bash commands against blocklist/allowlist before execution. Required with `permissionMode: bypassPermissions`. See `agent-hook-bash-validator.md` (rules) and `agent-hook-bash-validator-script.md` (shell implementation).

## References

- `docs/specs/workflow/workflow.md` -- Development Protocol (Reviewer role, Review Phase, Quality Gates for Review to Integrate)
- `docs/specs/workflow/skill-github-workflow.md` -- GitHub Workflow Skill spec (reference for `gh` command patterns and label rules; not loaded at runtime)
- `docs/specs/workflow/github-cli.md` -- GitHub CLI wrapper spec
- `docs/specs/workflow/script-label-setup.md` -- Label definitions for the repository
