---
title: GitHub Workflow Skill
version: 0.3.0
last_updated: 2026-02-07
status: approved
---

# GitHub Workflow Skill

## Overview

Internal agent skill that guides workflow agents (Planner, Implementor, Reviewer) through GitHub Issue and Pull Request operations using the `gh` CLI. Covers issue CRUD, PR lifecycle, label management, comment templates, and query patterns defined in the development protocol.

## Constraints

- All operations use the `gh` CLI (no direct GitHub API calls)
- Not user-invoked; used internally by agents only
- Label definitions (names, descriptions, colors) are maintained by `script-label-setup.md` -- not duplicated here
- The skill provides operation mechanics and templates; agents decide when to use them and what content to include

## Specification

### Issue Operations

#### Create Issue

- `gh issue create --title "<title>" --body "<body>" --label "<label>" --label "<label>" ...`
- Issue body templates (task and refinement) are defined in the skill's templates reference

#### Read Issue

- `gh issue view <number> --json number,title,body,labels,state,assignees,comments`

#### Update Issue

- `gh issue edit <number>` with `--title`, `--body`, `--add-label`, `--remove-label` flags

For mutually exclusive label categories (status, type, priority), remove the existing label and add the new one in a single command:

- `gh issue edit <number> --remove-label "status:in-progress" --add-label "status:review"`

#### Close Issue

Close an issue with a reason. Closing is a GitHub state change, not a label transition -- no status label swap is needed.

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

- Find a PR linked to a task issue: `gh pr list --search "Closes #<N>" --json number,title,headRefName,url`
- View PR metadata: `gh pr view <number> --json number,title,body,state,isDraft,headRefName,baseRefName,files,reviewDecision,statusCheckRollup,reviews`
- View the full PR diff: `gh pr diff <number>`

#### Update PR

- Convert draft to ready-for-review: `gh pr ready <number>`
- Update title or body: `gh pr edit <number>` with `--title` / `--body` flags

#### Merge PR

- `gh pr merge <number>` with `--merge`, `--squash`, or `--rebase`
- `gh pr merge <number> --delete-branch` to clean up the branch after merge

#### Add PR Review

Submit a formal PR review (shows as "Approved" or "Changes requested" on the PR):

- `gh pr review <number> --approve --body "<comment>"`
- `gh pr review <number> --request-changes --body "<comment>"`

#### Get CI Status

- `gh pr checks <number> --json name,state,conclusion`

### Label Management

Label definitions (names, descriptions, colors) are maintained by `script-label-setup.md`.

#### Mutually Exclusive Categories

An issue must have exactly one label within each category:

- **Type**: `task:implement`, `task:refinement`, `task:spec`
- **Status**: all `status:*` labels
- **Priority**: `priority:high`, `priority:medium`, `priority:low`

#### Valid Status Transitions

| From | To |
| --- | --- |
| `status:pending` | `status:in-progress` |
| `status:in-progress` | `status:blocked` |
| `status:in-progress` | `status:needs-refinement` |
| `status:in-progress` | `status:review` |
| `status:blocked` | `status:unblocked` |
| `status:needs-refinement` | `status:unblocked` |
| `status:unblocked` | `status:in-progress` |
| `status:review` | `status:approved` |
| `status:review` | `status:needs-changes` |
| `status:needs-changes` | `status:in-progress` |

### Comment Templates

Blocker and escalation comment templates are defined in the skill's templates reference.

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

### Issue Operations
- [ ] Given the agent needs to create a task issue, when it uses this skill, then the created issue has a title, body, and labels
- [ ] Given the agent needs to inspect a task issue, when it reads the issue, then it receives the issue's number, title, body, labels, state, assignees, and comments
- [ ] Given the agent needs to modify a task issue, when it updates the issue, then it can change the title, body, or labels
- [ ] Given the agent needs to close a task issue, when it closes the issue, then a reason is specified
- [ ] Given the agent needs to change issue assignment, when it updates the assignees, then users can be added or removed
- [ ] Given the agent needs to communicate on a task issue, when it adds a comment, then the comment is posted to the issue

### PR Operations
- [ ] Given the agent needs to create a PR, when it creates the PR, then the PR specifies a head branch, base branch, title in conventional commit format, and a body that references the task issue for automatic closing
- [ ] Given the agent needs to create a draft PR, when it creates the PR, then the PR is marked as a draft
- [ ] Given the agent needs to find a PR linked to a task issue, when it searches for PRs, then it receives structured output identifying the matching PR
- [ ] Given the agent needs to inspect a PR, when it reads the PR, then it receives metadata including state, draft status, branches, files, review decision, and CI status
- [ ] Given the agent needs to see what changed in a PR, when it views the diff, then it receives the full PR diff
- [ ] Given the agent needs to promote a draft PR, when it marks the PR as ready, then the PR is no longer a draft
- [ ] Given the agent needs to integrate a PR, when it merges the PR, then a merge strategy is specified
- [ ] Given the agent needs to submit a formal review verdict, when it reviews the PR, then the review is recorded as an approval or a request for changes with a comment
- [ ] Given the agent needs to check CI results, when it queries PR checks, then it receives the status and conclusion of each check

### Label Management
- [ ] Given a status label swap is needed, when the agent performs the update, then the old label is removed and the new label is added in a single command
- [ ] Given a mutually exclusive label category (type, status, or priority), when the agent changes the label, then exactly one label from that category exists on the issue afterward
- [ ] Given the agent performs a status transition, when the transition is inspected, then it matches one of the valid transitions defined in the status transition table

### Query Patterns
- [ ] Given the agent needs to find tasks by status, when it queries issues, then it receives structured output filtered by the specified status label
- [ ] Given the agent needs to find tasks by priority, when it queries issues, then it receives structured output filtered by the specified priority label
- [ ] Given the agent needs to find refinement issues, when it queries issues, then it receives structured output filtered to `task:refinement` type
- [ ] Given the agent needs to find all issues referencing a specific spec, when it queries issues, then it receives structured output filtered to issues whose body contains the spec file path

### General
- [ ] Given any GitHub operation performed through this skill, when inspected, then it uses the `gh` CLI

## Dependencies

- `gh` CLI (authenticated and available on PATH)
- Development protocol (`docs/workflow-v0.md`)
- Label setup script (`docs/specs/workflow/script-label-setup.md`)
- GitHub repository with labels created per protocol conventions

## References

- Development protocol: `docs/workflow-v0.md`
- Label setup script: `docs/specs/workflow/script-label-setup.md`
- Planner agent: `docs/specs/workflow/agent-planner.md`
- Implementor agent: `docs/specs/workflow/agent-implementor.md`
- Reviewer agent: `docs/specs/workflow/agent-reviewer.md`
