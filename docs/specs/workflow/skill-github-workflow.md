---
title: GitHub Workflow Skill
version: 0.6.0
last_updated: 2026-02-12
status: approved
---

# GitHub Workflow Skill

## Overview

Internal agent skill that guides workflow agents (Planner, Implementor, Reviewer) through GitHub
Issue and Pull Request operations using the `gh` CLI. Covers issue CRUD, PR lifecycle, label
management, comment templates, and query patterns defined in the development protocol.

## Constraints

- All operations use the `gh` CLI (no direct GitHub API calls)
- Not user-invoked; used internally by agents only
- Label definitions (names, descriptions, colors) are maintained by `script-label-setup.md` -- not
  duplicated here
- The skill provides operation mechanics and templates; agents decide when to use them and what
  content to include

## Specification

### Authentication

All `gh` CLI operations must be run through the authenticated wrapper script:

```bash
scripts/workflow/gh.sh <command> [args...]
```

The wrapper handles authentication automatically — it generates a GitHub App token (with local
caching) and exports `GH_TOKEN` before forwarding arguments to `gh` via `exec`. If the wrapper exits
non-zero before reaching `gh`, authentication has failed and the agent should abort.

### Issue Operations

#### Create Issue

- `gh issue create --title "<title>" --body "<body>" --label "<label>" --label "<label>" ...`
- Issue body templates (task and refinement) are defined in
  [workflow-contracts.md: GitHub Issue Templates](./workflow-contracts.md#github-issue-templates)

#### Read Issue

- `gh issue view <number> --json number,title,body,labels,state,assignees,comments`

#### Update Issue

- `gh issue edit <number>` with `--title`, `--body`, `--add-label`, `--remove-label` flags

For mutually exclusive label categories (status, type, priority), remove the existing label and add
the new one in a single command:

- `gh issue edit <number> --remove-label "status:pending" --add-label "status:in-progress"`

#### Close Issue

Close an issue with a reason. Closing is a GitHub state change, not a label transition -- no status
label swap is needed.

- `gh issue close <number> --reason completed`
- `gh issue close <number> --reason "not planned"`

#### Assign Issue

Assign or unassign users on an issue.

- `gh issue edit <number> --add-assignee <username>`
- `gh issue edit <number> --remove-assignee <username>`

#### Add Comment

- `gh issue comment <number> --body "<comment>"`
- `gh pr comment <number> --body "<comment>"`

### PR Operations

#### Create PR

- Build the PR title in conventional commit format: `<type>(<scope>): <description>`
- Build the PR body with `Closes #<issueNumber>`
- `gh pr create --head <branch> --base <baseBranch> --title "<title>" --body "<body>"`
- Add `--draft` for draft PRs

#### Read PR

- Find a PR linked to a task issue:
  `gh pr list --search "Closes #<N>" --json number,title,headRefName,url`
- View PR metadata:
  `gh pr view <number> --json number,title,body,state,isDraft,headRefName,baseRefName,files,reviewDecision,statusCheckRollup,reviews`
- View the full PR diff: `gh pr diff <number>`

#### Update PR

- Convert draft to ready-for-review: `gh pr ready <number>`
- Update title or body: `gh pr edit <number>` with `--title` / `--body` flags

#### Merge PR

- `gh pr merge <number>` with `--merge`, `--squash`, or `--rebase`
- `gh pr merge <number> --delete-branch` to clean up the branch after merge

#### Add PR Review

Post a review comment on the PR:

- `gh pr review <number> --comment --body "<comment>"`

The workflow uses a single GitHub App identity for all operations. All PR reviews use `--comment`
(not `--approve` or `--request-changes`). The canonical approval or rejection signal is the status
label on the task issue, not the PR review state.

> **Rationale:** GitHub prevents any identity from submitting `--approve` or `--request-changes`
> reviews on its own PRs.

#### Get CI Status

- `gh pr checks <number> --json name,state,conclusion`

### Label Management

Label definitions (names, descriptions, colors) are maintained by `script-label-setup.md`.

#### Mutually Exclusive Categories

An issue must have exactly one label within each category:

- **Type**: `task:implement`, `task:refinement`
- **Status**: all `status:*` labels
- **Priority**: `priority:high`, `priority:medium`, `priority:low`

#### Valid Status Transitions

The authoritative transition table is defined in
[workflow.md: Task Status Transitions](./workflow.md#task-status-transitions). This copy is provided
for agent convenience — `workflow.md` is the normative home.

| From                      | To                        |
| ------------------------- | ------------------------- |
| `status:pending`          | `status:in-progress`      |
| `status:in-progress`      | `status:blocked`          |
| `status:in-progress`      | `status:needs-refinement` |
| `status:in-progress`      | `status:review`           |
| `status:blocked`          | `status:unblocked`        |
| `status:needs-refinement` | `status:unblocked`        |
| `status:unblocked`        | `status:in-progress`      |
| `status:review`           | `status:approved`         |
| `status:review`           | `status:needs-changes`    |
| `status:needs-changes`    | `status:in-progress`      |

### Comment Templates

Blocker and escalation comment templates are defined in
[workflow-contracts.md: Issue Comment Formats](./workflow-contracts.md#issue-comment-formats).

### Query Patterns

Common query patterns for the workflow.

#### Find Tasks by Status

- `gh issue list --label "task:implement" --label "status:<status>" --state open --limit 100 --json number,title,labels,assignees`

#### Find Tasks by Priority

- `gh issue list --label "task:implement" --label "priority:<level>" --state open --limit 100 --json number,title,labels,assignees`

#### Find Refinement Issues

- `gh issue list --label "task:refinement" --state open --limit 100 --json number,title,labels,body`

#### Find All Open Tasks

- `gh issue list --label "task:implement" --state open --limit 100 --json number,title,labels,assignees`

#### Find Issues by Spec Reference

- `gh issue list --state open --search "in:body docs/specs/<name>.md" --limit 100 --json number,title,labels,body`

## Acceptance Criteria

### Label Management

- [ ] Given a status label swap is needed, when the agent performs the update, then the old label is
      removed and the new label is added in a single command (not two separate commands)
- [ ] Given a mutually exclusive label category (type, status, or priority), when the agent changes
      the label, then exactly one label from that category exists on the issue afterward
- [ ] Given the agent performs a status transition, when the transition is inspected, then it
      matches one of the valid transitions defined in the status transition table
- [ ] Given the agent attempts a status transition not in the valid transition table, when the
      operation is evaluated, then the transition is rejected

### Authentication and Error Handling

- [ ] Given the authentication script exits with a non-zero code, when the agent observes the
      failure, then it aborts without attempting any `gh` operations
- [ ] Given the agent attempts to add a label that does not exist in the repository, when the `gh`
      command runs, then the error is surfaced to the agent (not silently swallowed)
- [ ] Given the agent queries an issue number that does not exist, when the `gh` command runs, then
      the error is surfaced to the agent

### Constraint Enforcement

- [ ] Given any GitHub operation performed through this skill, when inspected, then it uses the `gh`
      CLI (no direct GitHub API calls)
- [ ] Given the agent needs to submit a review verdict, when it reviews the PR, then the review is
      posted using `--comment` only (never `--approve` or `--request-changes`) and the verdict is
      conveyed via the task issue's status label
- [ ] Given a PR search returns no results for a task issue, when the agent processes the empty
      result, then it handles the absence gracefully (no assumption that a PR always exists)

## Dependencies

- `gh` CLI (available on PATH, authenticated via `GH_TOKEN`)
- GitHub CLI wrapper (`docs/specs/workflow/github-cli.md`)
- Development protocol (`docs/specs/workflow/workflow.md`)
- Label setup script (`docs/specs/workflow/script-label-setup.md`)
- GitHub repository with labels created per protocol conventions

## References

- Development protocol: `docs/specs/workflow/workflow.md`
- GitHub CLI wrapper: `docs/specs/workflow/github-cli.md`
- Label setup script: `docs/specs/workflow/script-label-setup.md`
- Planner agent: `docs/specs/workflow/agent-planner.md`
- Implementor agent: `docs/specs/workflow/agent-implementor.md`
- Reviewer agent: `docs/specs/workflow/agent-reviewer.md`
