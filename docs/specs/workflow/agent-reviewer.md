---
title: Reviewer Agent
version: 0.7.0
last_updated: 2026-02-11
status: approved
---

# Reviewer Agent

## Overview

Agent that reviews completed implementation work against acceptance criteria, spec conformance, code quality, and scope boundaries before integration. The Reviewer either approves the work for Human integration or rejects it with actionable feedback for the Implementor to address. The Reviewer never merges — that is the Human's responsibility.

## Constraints

- Must not merge PRs. Approval means setting `status:approved`; the Human performs the merge.
- Must never reject without providing actionable feedback explaining what needs to change and why. Each piece of feedback must include what is wrong, why it is wrong, and what to change (see `workflow-contracts.md` § Review Rejection Template).
- Must use `scripts/workflow/gh.sh` for all GitHub CLI operations (see `skill-github-workflow.md` § Authentication for wrapper behavior).
- Scope issues are reported as warnings, not as findings that trigger rejection.
- The agent definition body must include the permitted bash command list from `agent-hook-bash-validator.md` § Allowlist Prefixes to prevent wasted turns on blocked commands.

## Agent Profile

| Constraint | Value | Rationale |
|-----------|-------|-----------|
| Model tier | Sonnet | Read-only analysis; Opus not required |
| Tool access | No write tools (Read, Grep, Glob, Bash) | Must never modify the codebase under review |
| Turn budget | 50 | Bounded analysis, not open-ended work |
| Permission model | Non-interactive with bash validation | Runs unattended; bash validator enforces command safety |

The agent definition (`.claude/agents/reviewer.md`) implements these constraints as frontmatter. See `control-plane-engine-agent-manager.md` § Frontmatter Field Mapping for how the Engine parses them.

## Trigger

The Reviewer is invoked with a task issue number when the task has `status:review` (see `control-plane-engine.md` § Completion-dispatch for trigger mechanism).

## Inputs

The Engine injects the following into the agent's session at dispatch time (see `control-plane-engine-agent-manager.md` § Trigger Context and § Project Context Injection):

1. **Trigger prompt:** The task issue number (e.g., `"42"`).
2. **Project context:** CLAUDE.md content (coding conventions, style rules, architecture) appended to the agent's system prompt.
3. **Working directory:** A git worktree checked out to the PR branch at the latest remote state (see `control-plane-engine-agent-manager.md` § Agent Lifecycle, step 2). The Reviewer reads the implementation files as they exist on the PR branch, not on `main`.

The agent fetches all remaining data via tool calls: the task issue body, the linked PR and its diff, referenced spec sections, and existing PR review comments.

## Input Validation

Before running the review checklist, the agent validates that an open PR linked to the task issue exists. Without a PR there is no diff to review.

If no linked PR is found, the agent posts a comment to the task issue using the Review Validation Failure Comment format (see `workflow-contracts.md` § Review Validation Failure Comment) and stops. The agent does not change the task's status label on validation failure.

## Review Checklist

The agent evaluates the PR against each of the following criteria. All six steps run on every review — individual failures do not short-circuit the remaining steps. Findings from all steps are collected and delivered in a single PR review comment.

**Warnings vs. findings:** If a step's required input is missing (e.g., no Scope section, no Spec Reference, spec file does not exist or is not `status: approved`), the agent records a warning for that step and proceeds to the next. Warnings indicate a step was skipped or a scope observation; findings indicate a problem with the code. Warnings do not count toward the approval/rejection decision but are included in the review comment for visibility.

### 1. Unresolved Review Comments

Applies when review comments exist on the PR from non-automated sources (prior Reviewer runs, other reviewers, contributors). Automated bot comments (linters, CI, security scanners) are excluded.

- Verify each previously raised issue has been addressed: either the code was changed to resolve it, or the author replied explaining why no change is needed.
- Record unaddressed items as findings.

### 2. Scope Compliance

Compare files modified in the PR diff against the task issue's scope, applying the scope enforcement rules defined in `workflow-contracts.md` § Scope Enforcement Rules.

If a modified file is neither in primary scope, a co-located test file, nor an incidental change, record it as a warning (not a finding) with an explanation.

### 3. Task Constraints

If the task issue includes a "Constraints" section, verify the implementation honors each constraint. Record a per-constraint breakdown: which were satisfied and which were violated, with an explanation for each violation. If the section is absent, record a warning and proceed.

### 4. Acceptance Criteria Verification

For each acceptance criterion in the task issue:
- Verify the implementation satisfies it.
- Check that tests exist which exercise it.
- Record a per-criterion breakdown: which passed, which failed, and an explanation for each failure.

### 5. Spec Conformance

Read the referenced spec sections and compare the implementation against the specified behavior. Verify the implementation does not contradict, omit, or extend beyond what the spec requires. Record deviations with the specific spec file, section, and description.

### 6. Code Quality and Consistency

Verify code follows the project's style, naming conventions, and patterns defined in `CLAUDE.md`. Check for readability, maintainability, consistency with existing codebase patterns, and common issues (missing error handling at system boundaries, security vulnerabilities, unnecessary complexity). Record issues with specific file paths, line references, and suggested improvements.

## Approval and Rejection

**Approval:** When all checklist steps pass (no findings), the agent submits a PR review comment using the Review Approval Template (see `workflow-contracts.md` § Review Approval Template) and transitions the task label from `status:review` to `status:approved`. The label is the canonical approval signal.

**Rejection:** When one or more checklist steps have findings, the agent submits a PR review comment using the Review Rejection Template (see `workflow-contracts.md` § Review Rejection Template) and transitions the task label from `status:review` to `status:needs-changes`.

## Status Transitions

| From | To | When |
|------|----|------|
| `status:review` | `status:approved` | All review checklist steps pass |
| `status:review` | `status:needs-changes` | One or more review checklist steps have findings |

The agent must not perform any other status transitions.

## Completion Output

On every run (approval, rejection, or validation failure), the agent returns the Reviewer Completion Output (see `workflow-contracts.md` § Reviewer Completion Output) as its final text output to the invoking process.

## Acceptance Criteria

- [ ] Given no open PR linked to the task issue, when the agent validates inputs, then it posts a validation failure comment and stops without changing the status label.
- [ ] Given a task issue missing a required section (Scope, Acceptance Criteria, or Spec Reference), when the agent reviews the PR, then the review includes a warning for each affected checklist step and the remaining steps still run.
- [ ] Given a referenced spec file that does not exist or is not `status: approved`, when the agent reviews the PR, then the spec conformance step records a warning and the remaining steps still run.
- [ ] Given a task issue with no Constraints section, when the agent reviews the PR, then the task constraints step records a warning and the remaining steps still run.
- [ ] Given a PR with unresolved review comments from non-automated sources, when the agent reviews it, then it records unaddressed items as findings.
- [ ] Given a PR that modifies files outside primary scope where the modification qualifies as incidental, then the Reviewer does not flag it as a scope warning.
- [ ] Given a PR that modifies files outside primary scope where the modification does not qualify as incidental, then the Reviewer records a scope warning. The warning does not trigger rejection.
- [ ] Given a PR that satisfies all checklist steps, when the agent completes the review, then the task label is `status:approved` and a PR review comment confirms the approval.
- [ ] Given a PR that fails one or more acceptance criteria, when the agent rejects it, then the feedback includes a per-criterion breakdown indicating which passed and which failed.
- [ ] Given the agent rejects a PR, when the review is examined, then each finding includes what is wrong, why it is wrong, and what needs to change.
- [ ] Given a PR with a spec deviation, when the agent rejects it, then the feedback references the specific spec file and section.
- [ ] Given a PR that violates a task constraint, when the agent rejects it, then the feedback identifies the constraint and explains the violation.
- [ ] Given a PR with code quality issues, when the agent rejects it, then the feedback references specific files and lines with suggested improvements.
- [ ] Given the agent finishes execution (any outcome), then it has returned a completion summary matching the Reviewer Completion Output format.

## Dependencies

- `scripts/workflow/gh.sh` — Authenticated `gh` CLI wrapper (see `docs/specs/workflow/github-cli.md`). All GitHub operations (label changes, issue comments, PR reviews).
- `CLAUDE.md` — Code style, naming conventions, and patterns that the agent checks against.
- `workflow-contracts.md` — Shared data formats: Review Approval Template, Review Rejection Template, Review Validation Failure Comment, Reviewer Completion Output, Scope Enforcement Rules.
- Agent Bash Tool Validator — PreToolUse hook that validates all Bash commands against blocklist/allowlist before execution. See `agent-hook-bash-validator.md` (rules) and `agent-hook-bash-validator-script.md` (shell implementation).

## References

- `docs/specs/workflow/workflow.md` — Development Protocol (Reviewer role, Review Phase, Quality Gates for Review to Integrate)
- `docs/specs/workflow/skill-github-workflow.md` — GitHub Workflow Skill spec (reference for `gh` command patterns and label rules; not loaded at runtime)
- `docs/specs/workflow/github-cli.md` — GitHub CLI wrapper spec
- `docs/specs/workflow/script-label-setup.md` — Label definitions for the repository
