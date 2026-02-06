---
name: github-workflow
description: >-
  Internal agent skill for GitHub Issue and PR operations via the `gh` CLI.
  Used by workflow agents (Planner, Implementor, Reviewer) for: issue CRUD,
  PR lifecycle (create, review, merge), label management with mutually exclusive
  categories and status transitions, comment posting, CI status checks, and
  query patterns. Not user-invoked; triggered internally when agents perform
  GitHub operations defined in the development protocol.
---

# GitHub Workflow Skill

Mechanics for GitHub Issue and PR operations using `gh` CLI. Agents decide when to use these operations and what content to include.

## Issue Operations

### Create

```
gh issue create --title "<title>" --body "<body>" --label "<label>" --label "<label>" ...
```

Issue body template: see [references/templates.md](references/templates.md) § "Issue Body Template".

### Read

```
gh issue view <number> --json number,title,body,labels,state,assignees,comments
```

### Update

```
gh issue edit <number> --title "<title>" --body "<body>" --add-label "<label>" --remove-label "<label>"
```

For mutually exclusive label swaps, remove and add in a single command:

```
gh issue edit <number> --remove-label "status:in-progress" --add-label "status:review"
```

### Close

```
gh issue close <number> --reason completed
gh issue close <number> --reason "not planned"
```

Closing is a GitHub state change -- no status label swap is needed.

### Assign

```
gh issue edit <number> --add-assignee <username>
gh issue edit <number> --remove-assignee <username>
```

### Comment

```
gh issue comment <number> --body "<comment>"
gh pr comment <number> --body "<comment>"
```

Comment templates (blocker, escalation): see [references/templates.md](references/templates.md).

## PR Operations

### Create

Build title in conventional commit format: `<type>(<scope>): <description>`
Build body with `Closes #<issueNumber>`.

```
gh pr create --head <branch> --base <baseBranch> --title "<title>" --body "<body>"
```

Add `--draft` for draft PRs.

### Read

Find PR linked to a task issue:

```
gh pr list --search "Closes #<N>" --json number,title,headRefName,url
```

View PR metadata:

```
gh pr view <number> --json number,title,body,state,isDraft,headRefName,baseRefName,files,reviewDecision,statusCheckRollup,reviews
```

View full diff:

```
gh pr diff <number>
```

### Update

```
gh pr ready <number>
gh pr edit <number> --title "<title>" --body "<body>"
```

### Merge

```
gh pr merge <number> --squash --delete-branch
```

Use `--merge`, `--squash`, or `--rebase` for merge strategy.

### Review

```
gh pr review <number> --approve --body "<comment>"
gh pr review <number> --request-changes --body "<comment>"
```

### CI Status

```
gh pr checks <number> --json name,state,conclusion
```

## Label Management

Label definitions are maintained by `docs/specs/workflow/script-label-setup.md`.

**Rules:** see [references/labels.md](references/labels.md) for mutually exclusive categories and valid status transitions.

Key rules:
- Mutually exclusive categories (type, status, priority): exactly one label per category
- Status transitions must follow the valid transition table
- Swap labels atomically: `--remove-label "old" --add-label "new"` in one command

## Query Patterns

### By status

```
gh issue list --label "task:implement" --label "status:<status>" --state open --limit 100 --json number,title,labels,assignees
```

### By priority

```
gh issue list --label "task:implement" --label "priority:<level>" --state open --limit 100 --json number,title,labels,assignees
```

### Refinement tasks

```
gh issue list --label "task:refinement" --state open --limit 100 --json number,title,labels,body
```

### All open tasks

```
gh issue list --label "task:implement" --state open --limit 100 --json number,title,labels,assignees
```

## Dependencies

- `gh` CLI authenticated and on PATH
- Labels created per `docs/specs/workflow/script-label-setup.md`
- Development protocol: `docs/workflow-v0.md`
