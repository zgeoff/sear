---
title: Reviewer Agent
version: 0.9.0
last_updated: 2026-02-12
status: approved
---

# Reviewer Agent

## Overview

Agent that reviews completed implementation work against acceptance criteria, spec conformance, code
quality, and scope boundaries before integration. The Reviewer either approves the work for Human
integration or rejects it with actionable feedback for the Implementor to address. The Reviewer
never merges — that is the Human's responsibility.

## Constraints

- Must not merge PRs. Approval means setting `status:approved`; the Human performs the merge.
- Must never reject without providing actionable feedback explaining what needs to change and why.
  Each piece of feedback must include what is wrong, why it is wrong, and what to change (see
  [workflow-contracts.md: Review Rejection Template](./workflow-contracts.md#review-rejection-template)).
- Must use `scripts/workflow/gh.sh` for all GitHub CLI operations (see
  [skill-github-workflow.md: Authentication](./skill-github-workflow.md#authentication) for wrapper
  behavior).
- Scope issues are reported as warnings, not as findings that trigger rejection.
- The agent definition body must include the permitted bash command list from
  [agent-hook-bash-validator.md: Allowlist Prefixes](./agent-hook-bash-validator.md#allowlist-prefixes)
  to prevent wasted turns on blocked commands.
- Must read the full source file for any file with non-trivial changes; the injected diff is for
  triage and identification only.
- Must read changed test files in full to assess coverage, assertion quality, and setup correctness.
- Must cross-reference each prior review comment against the current diff during re-reviews;
  comments referencing unmodified code must be investigated.
- Must fetch referenced spec sections via tool calls; spec content is not included in the enriched
  prompt.

## Agent Profile

| Constraint       | Value                                   | Rationale                                               |
| ---------------- | --------------------------------------- | ------------------------------------------------------- |
| Model tier       | Sonnet                                  | Read-only analysis; Opus not required                   |
| Tool access      | No write tools (Read, Grep, Glob, Bash) | Must never modify the codebase under review             |
| Turn budget      | 50                                      | Bounded analysis, not open-ended work                   |
| Permission model | Non-interactive with bash validation    | Runs unattended; bash validator enforces command safety |

The agent definition (`.claude/agents/reviewer.md`) implements these constraints as frontmatter. See
[control-plane-engine-agent-manager.md: Agent Definition Loading](./control-plane-engine-agent-manager.md#agent-definition-loading)
for how the Engine parses them.

## Trigger

The Reviewer is invoked with a task issue number when the task has `status:review` (see
[control-plane-engine.md: Completion-dispatch](./control-plane-engine.md#completion-dispatch) for
trigger mechanism).

## Inputs

The Engine injects the following into the agent's session at dispatch time (see
[control-plane-engine-agent-manager.md: Trigger Context](./control-plane-engine-agent-manager.md#trigger-context),
[Project Context Injection](./control-plane-engine-agent-manager.md#project-context-injection), and
[Reviewer Context Pre-computation](./control-plane-engine-context-precomputation.md#reviewer-context-pre-computation)):

1. **Trigger prompt:** An enriched prompt containing:
   - **Task issue details** — number, title, body (objective, spec reference, scope, acceptance
     criteria), and labels.
   - **PR metadata** — PR number and title (from the `getPRForIssue` call that precedes dispatch).
   - **PR diffs** — per-file patches (filename, status, unified diff) for all changed files in the
     linked PR.
   - **Prior review history** — review submissions (author, state, body) and inline comments
     (author, body, path, line) from prior Reviewer runs and Human reviewers. Empty on first review.
2. **Project context:** CLAUDE.md content (coding conventions, style rules, architecture) appended
   to the agent's system prompt.
3. **Working directory:** A git worktree checked out to the PR branch at the latest remote state
   (see
   [control-plane-engine-agent-manager.md: Agent Lifecycle](./control-plane-engine-agent-manager.md#agent-lifecycle),
   step 2). The Reviewer reads the implementation files as they exist on the PR branch, not on
   `main`.

PR existence is guaranteed by the engine's dispatch preconditions — both completion-dispatch and
manual `dispatchReviewer` verify a linked PR before dispatching.

## Review Checklist

The agent evaluates the PR against each of the following criteria. All six steps run on every review
— individual failures do not short-circuit the remaining steps. Findings from all steps are
collected and delivered in a single PR review comment.

**Warnings vs. findings:** If a step's required input is missing (e.g., no Scope section, no Spec
Reference, spec file does not exist or is not `status: approved`), the agent records a warning for
that step and proceeds to the next. Warnings indicate a step was skipped or a scope observation;
findings indicate a problem with the code. Warnings do not count toward the approval/rejection
decision but are included in the review comment for visibility.

### 1. Unresolved Review Comments

Applies when review comments exist on the PR from non-automated sources (prior Reviewer runs, other
reviewers, contributors). Automated bot comments (linters, CI, security scanners) are excluded.

- Verify each previously raised issue has been addressed: either the code was changed to resolve it,
  or the author replied explaining why no change is needed.
- Record unaddressed items as findings.

### 2. Scope Compliance

Compare files modified in the PR diff against the task issue's scope, applying the scope enforcement
rules defined in
[workflow-contracts.md: Scope Enforcement Rules](./workflow-contracts.md#scope-enforcement-rules).

If the PR body contains a "Scope correction" section (rule 4 of the scope enforcement rules), files
listed as the corrected scope are treated as effective primary scope — no warning is recorded.

If a modified file is neither in primary scope, a co-located test file, an incidental change, nor
covered by a documented scope inaccuracy, record it as a warning (not a finding) with an
explanation.

### 3. Task Constraints

If the task issue includes a "Constraints" section, verify the implementation honors each
constraint. Record a per-constraint breakdown: which were satisfied and which were violated, with an
explanation for each violation. If the section is absent, record a warning and proceed.

### 4. Acceptance Criteria Verification

For each acceptance criterion in the task issue:

- Verify the implementation satisfies it.
- Check that tests exist which exercise it.
- Record a per-criterion breakdown: which passed, which failed, and an explanation for each failure.

### 5. Spec Conformance

Read the referenced spec sections and compare the implementation against the specified behavior.
Verify the implementation does not contradict, omit, or extend beyond what the spec requires. Record
deviations with the specific spec file, section, and description.

### 6. Code Quality and Consistency

Verify code follows the project's style, naming conventions, and patterns defined in `CLAUDE.md`.
Check for readability, maintainability, consistency with existing codebase patterns, and common
issues (missing error handling at system boundaries, security vulnerabilities, unnecessary
complexity). Record issues with specific file paths, line references, and suggested improvements.

## Approval and Rejection

**Approval:** When all checklist steps pass (no findings), the agent submits a PR review comment
using the Review Approval Template (see
[workflow-contracts.md: Review Approval Template](./workflow-contracts.md#review-approval-template))
and transitions the task label from `status:review` to `status:approved`. The label is the canonical
approval signal.

**Rejection:** When one or more checklist steps have findings, the agent submits a PR review comment
using the Review Rejection Template (see
[workflow-contracts.md: Review Rejection Template](./workflow-contracts.md#review-rejection-template))
and transitions the task label from `status:review` to `status:needs-changes`.

## Status Transitions

| From            | To                     | When                                             |
| --------------- | ---------------------- | ------------------------------------------------ |
| `status:review` | `status:approved`      | All review checklist steps pass                  |
| `status:review` | `status:needs-changes` | One or more review checklist steps have findings |

The agent must not perform any other status transitions.

## Completion Output

On every run (approval or rejection), the agent returns the Reviewer Completion Output (see
[workflow-contracts.md: Reviewer Completion Output](./workflow-contracts.md#reviewer-completion-output))
as its final text output to the invoking process.

## Acceptance Criteria

- [ ] Given the agent receives an enriched prompt with per-file diffs, when it reviews a file with
      non-trivial changes, then it reads the full file via a tool call before assessing correctness.
- [ ] Given the agent receives an enriched prompt with per-file diffs, when a changed file is a test
      file, then the agent reads the full test file before assessing test quality.
- [ ] Given the agent receives an enriched prompt with prior review comments (re-review scenario),
      when it reviews the PR, then it cross-references each prior comment against the current diff
      and records unaddressed items as findings.
- [ ] Given a re-review scenario where a prior review comment references a file that was not
      modified in the current diff, when the agent reviews the PR, then it investigates whether the
      feedback was addressed (by reading the file or checking the author's reply).
- [ ] Given the agent performs spec conformance checking, when it reads the referenced spec, then it
      fetches the spec file content via a tool call (not from the enriched prompt).
- [ ] Given a task issue missing a required section (Scope, Acceptance Criteria, or Spec Reference),
      when the agent reviews the PR, then the review includes a warning for each affected checklist
      step and the remaining steps still run.
- [ ] Given a referenced spec file that does not exist or is not `status: approved`, when the agent
      reviews the PR, then the spec conformance step records a warning and the remaining steps still
      run.
- [ ] Given a task issue with no Constraints section, when the agent reviews the PR, then the task
      constraints step records a warning and the remaining steps still run.
- [ ] Given a PR with unresolved review comments from non-automated sources, when the agent reviews
      it, then it records unaddressed items as findings.
- [ ] Given a PR that modifies files outside primary scope where the modification qualifies as
      incidental, then the Reviewer does not flag it as a scope warning.
- [ ] Given a PR that modifies files outside primary scope where the modification does not qualify
      as incidental, then the Reviewer records a scope warning. The warning does not trigger
      rejection.
- [ ] Given a PR whose body contains a "Scope correction" section documenting a scope inaccuracy,
      when the Reviewer checks scope compliance, then files listed as the corrected scope are
      treated as effective primary scope and no scope warning is recorded for them.
- [ ] Given a PR that satisfies all checklist steps, when the agent completes the review, then the
      task label is `status:approved` and a PR review comment confirms the approval.
- [ ] Given a PR that fails one or more acceptance criteria, when the agent rejects it, then the
      feedback includes a per-criterion breakdown indicating which passed and which failed.
- [ ] Given the agent rejects a PR, when the review is examined, then each finding includes what is
      wrong, why it is wrong, and what needs to change.
- [ ] Given a PR with a spec deviation, when the agent rejects it, then the feedback references the
      specific spec file and section.
- [ ] Given a PR that violates a task constraint, when the agent rejects it, then the feedback
      identifies the constraint and explains the violation.
- [ ] Given a PR with code quality issues, when the agent rejects it, then the feedback references
      specific files and lines with suggested improvements.
- [ ] Given the agent finishes execution (any outcome), then it has returned a completion summary
      matching the Reviewer Completion Output format.

## Dependencies

- `scripts/workflow/gh.sh` — Authenticated `gh` CLI wrapper (see
  `docs/specs/workflow/github-cli.md`). All GitHub operations (label changes, issue comments, PR
  reviews).
- `CLAUDE.md` — Code style, naming conventions, and patterns that the agent checks against.
- `workflow-contracts.md` — Shared data formats: Review Approval Template, Review Rejection
  Template, Reviewer Completion Output, Scope Enforcement Rules.
- [control-plane-engine-context-precomputation.md: Reviewer Context Pre-computation](./control-plane-engine-context-precomputation.md#reviewer-context-pre-computation)
  — Enriched prompt format and data sources.
- Agent Bash Tool Validator — PreToolUse hook that validates all Bash commands against
  blocklist/allowlist before execution. See `agent-hook-bash-validator.md` (rules) and
  `agent-hook-bash-validator-script.md` (shell implementation).

## References

- `docs/specs/workflow/workflow.md` — Development Protocol (Reviewer role, Review Phase, Quality
  Gates for Review to Integrate)
- `docs/specs/workflow/skill-github-workflow.md` — GitHub Workflow Skill spec (reference for `gh`
  command patterns and label rules; not loaded at runtime)
- `docs/specs/workflow/github-cli.md` — GitHub CLI wrapper spec
- `docs/specs/workflow/script-label-setup.md` — Label definitions for the repository
