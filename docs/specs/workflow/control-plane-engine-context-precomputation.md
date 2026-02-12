---
title: Control Plane Engine — Context Pre-computation
version: 0.3.0
last_updated: 2026-02-12
status: approved
---

# Control Plane Engine — Context Pre-computation

## Overview

Before dispatching the Planner, Implementor, or Reviewer, the Engine Core builds enriched trigger
prompts so agents start with all context in hand, avoiding costly tool-call turns for data
gathering. The Engine Core assembles these prompts and passes them to the `QueryFactory` as the
session's initial prompt.

## Constraints

- Context pre-computation failures are treated as agent session creation failures — the session is
  not created.
- The Engine Core performs all data fetching; the Agent Manager receives the fully-assembled prompt.

## Specification

### Planner Context Pre-computation

When dispatching the Planner, the Engine Core builds an enriched trigger prompt so the Planner
starts with all context in hand, avoiding costly tool-call turns for data gathering. The Engine Core
assembles this prompt before calling the `QueryFactory`.

**Enriched prompt format:**

```
## Changed Specs

### <filePath> (added)
<full file content fetched via repos.getContent>

### <filePath> (modified)
<full file content fetched via repos.getContent>

#### Diff
<unified diff output from git diff>

## Existing Open Issues
<JSON array of {number, title, labels, body} for all open task:implement and task:refinement issues>
```

For added specs, only the full content is included (no diff — all content is new). For modified
specs, the full content is followed by a unified diff showing what changed since the last successful
Planner run.

**Data sources:**

| Data            | Source                                                                                                                                                                                                                                                                         | When fetched             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Spec content    | `GitHubClient.repos.getContent` for each changed spec path, using the current commit SHA as ref                                                                                                                                                                                | At planner dispatch time |
| Spec diffs      | `git diff <previousCommitSHA>..<currentCommitSHA> -- <path>` for each modified spec. Previous commit SHA: from the planner cache (see `control-plane-engine-planner-cache.md`). Current commit SHA: from the `SpecPollerBatchResult.commitSHA`. Skipped for added specs.       | At planner dispatch time |
| Existing issues | `GitHubClient.issues.listForRepo` filtered to open issues with `task:implement` or `task:refinement` labels, requesting `number`, `title`, `labels`, and `body` fields. Fetched in a single API call (`per_page: 100`, no pagination — same v1 limitation as the IssuePoller). | At planner dispatch time |

> **Rationale:** Pre-computing diffs in the engine saves the Planner at least one Bash tool-call
> turn per invocation. The engine runs `git diff` locally — this is a cheap local operation that
> avoids adding GitHub Compare API calls.

**Error handling:** If spec content or issue list fetching fails (GitHub API error), the Planner
dispatch fails. This is treated as an agent session creation failure — logged at `error` level,
retried on the next SpecPoller cycle (the deferred paths mechanism re-adds the spec paths).

### Implementor Context Pre-computation

When dispatching the Implementor (via `dispatchImplementor`), the Engine Core builds an enriched
trigger prompt so the Implementor starts with the task issue context in hand and — when resuming a
task with a linked PR — the current PR diff and prior review feedback. This eliminates the
Implementor's initial data-gathering tool-call turns (issue fetch via `gh.sh`, and for resume
scenarios, PR diff and review comment fetch).

The Engine Core already calls `getPRForIssue` before every Implementor dispatch (for branch strategy
selection). The presence or absence of a linked PR determines the prompt tier:

- **No linked PR:** The prompt includes the task issue details only.
- **Linked PR exists:** The prompt includes the task issue details, per-file PR diffs, and prior
  review history (same sections as the Reviewer prompt).

**Enriched prompt format — no linked PR:**

```
## Task Issue #<number> — <title>

<issue body>

### Labels
<comma-separated label names>
```

**Enriched prompt format — linked PR exists:**

```
## Task Issue #<number> — <title>

<issue body>

### Labels
<comma-separated label names>

## PR #<prNumber> — <prTitle>

### Changed Files

#### <filename> (<status>)
```

<patch>
```

#### <filename> (<status>)

```
<patch>
```

### CI Status: FAILURE

#### <checkName> — failure

Details: <detailsURL>

#### <checkName> — cancelled

Details: <detailsURL>

### Prior Reviews

#### Review by <author> — <state>

<body>

### Prior Inline Comments

#### <path>:<line> — <author>

<body>
```

The issue section format is identical to the Reviewer prompt format. When a linked PR exists, the PR
section, Prior Reviews, and Prior Inline Comments sections also use the identical Reviewer format.
For files with no `patch` (binary files or files exceeding the diff size limit), the file entry
includes the filename and status but no code block. When no prior reviews or inline comments exist,
the "Prior Reviews" and "Prior Inline Comments" sections are omitted entirely. The `createdAt` field
from `IssueDetailsResult` is excluded — it is not useful for implementation.

The "CI Status" section is only included when `getCIStatus(prNumber)` returns `overall: 'failure'`.
Only check runs with `conclusion` of `'failure'`, `'cancelled'`, or `'timed_out'` are listed. The
section is omitted entirely when CI status is `'success'` or `'pending'`.

> **Rationale:** Pre-computing the issue body eliminates a `gh.sh issue view` tool-call turn that
> every Implementor invocation previously required. For resume scenarios, pre-computing PR diffs and
> review comments eliminates additional turns the agent would spend fetching review feedback —
> particularly valuable for `status:needs-changes` where understanding review comments is the first
> step.

**Data sources:**

| Data           | Source                                                                                                                                       | When fetched                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Issue details  | `getIssueDetails(issueNumber)`                                                                                                               | At Implementor dispatch time |
| PR details     | `getPRForIssue(issueNumber, { includeDrafts: true })` — already called for branch strategy; PR number and title reused                       | At Implementor dispatch time |
| PR files       | `getPRFiles(prNumber)` — called only when `getPRForIssue` returned a linked PR                                                               | At Implementor dispatch time |
| Review history | `getPRReviews(prNumber)` — called only when `getPRForIssue` returned a linked PR                                                             | At Implementor dispatch time |
| CI status      | `getCIStatus(prNumber)` — called only when `getPRForIssue` returned a linked PR. Omitted from prompt when overall status is not `'failure'`. | At Implementor dispatch time |

**Error handling:** If any fetch fails (GitHub API error), the Implementor dispatch fails. This is
treated as an agent session creation failure — logged at `error` level. No automatic retry exists —
the user can manually dispatch an Implementor via the TUI's `dispatchImplementor` command.

### Reviewer Context Pre-computation

When dispatching the Reviewer (via completion-dispatch or manual `dispatchReviewer`), the Engine
Core builds an enriched trigger prompt so the Reviewer starts with task context, PR changes, and
prior review feedback in hand. The Engine Core assembles this prompt before calling the
`QueryFactory`. This eliminates the Reviewer's initial data-gathering tool-call turns (issue fetch,
PR diff, review comment fetch).

The Engine Core already has the PR number and title from the `getPRForIssue` call that precedes
every Reviewer dispatch (completion-dispatch and manual dispatch both call `getPRForIssue` first).
The PR number is passed to `getPRFiles` and `getPRReviews` directly — no redundant issue→PR lookup.
The PR title is used in the prompt header.

**Enriched prompt format:**

```
## Task Issue #<number> — <title>

<issue body>

### Labels
<comma-separated label names>

## PR #<prNumber> — <prTitle>

### Changed Files

#### <filename> (<status>)
```

<patch>
```

#### <filename> (<status>)

```
<patch>
```

### Prior Reviews

#### Review by <author> — <state>

<body>

### Prior Inline Comments

#### <path>:<line> — <author>

<body>
```

For files with no `patch` (binary files or files exceeding the diff size limit), the file entry
includes the filename and status but no code block. For first-time reviews with no prior review
history, the "Prior Reviews" and "Prior Inline Comments" sections are omitted entirely. The
`createdAt` field from `IssueDetailsResult` is intentionally excluded — it is not useful for code
review.

**Data sources:**

| Data           | Source                                                                              | When fetched              |
| -------------- | ----------------------------------------------------------------------------------- | ------------------------- |
| Issue details  | `getIssueDetails(issueNumber)`                                                      | At Reviewer dispatch time |
| PR files       | `getPRFiles(prNumber)` — PR number obtained from the preceding `getPRForIssue` call | At Reviewer dispatch time |
| Review history | `getPRReviews(prNumber)` — same PR number                                           | At Reviewer dispatch time |

**Error handling:** If any fetch fails (GitHub API error), the Reviewer dispatch fails. This is
treated as an agent session creation failure — logged at `error` level. For completion-dispatch
failures, the deferred paths mechanism does not apply (that is Planner-specific). No automatic retry
exists — the user can manually dispatch a Reviewer via the TUI's `dispatchReviewer` command.

## Acceptance Criteria

### Planner Context Pre-computation

- [ ] Given the Engine Core dispatches the Planner, when it builds the trigger prompt, then the
      prompt includes the full content of each changed spec fetched via `repos.getContent`.
- [ ] Given the Engine Core dispatches the Planner, when it builds the trigger prompt, then the
      prompt includes a JSON array of all open `task:implement` and `task:refinement` issues with
      number, title, labels, and body fields.
- [ ] Given the Engine Core dispatches the Planner with modified specs, when it builds the trigger
      prompt, then the prompt includes a unified diff for each modified spec computed via `git diff`
      using the cached and current commit SHAs.
- [ ] Given the Engine Core dispatches the Planner with added specs only, when it builds the trigger
      prompt, then no diffs are included (only full content).
- [ ] Given a spec content fetch fails during planner dispatch, when the error is caught, then the
      dispatch fails (treated as agent session creation failure) and the spec paths are re-added to
      the deferred buffer.

### Implementor Context Pre-computation

- [ ] Given the Engine Core dispatches the Implementor, when it builds the trigger prompt, then the
      prompt includes the issue body and labels fetched via `getIssueDetails`.
- [ ] Given the Engine Core dispatches the Implementor for an issue with no linked PR, when it
      builds the trigger prompt, then the prompt contains only the issue section (no PR, reviews, or
      inline comments sections).
- [ ] Given the Engine Core dispatches the Implementor for an issue with a linked PR, when it builds
      the trigger prompt, then the prompt includes per-file patches fetched via `getPRFiles` using
      the PR number from the preceding `getPRForIssue` call.
- [ ] Given the Engine Core dispatches the Implementor for an issue with a linked PR, when it builds
      the trigger prompt, then the prompt includes prior review submissions and inline comments
      fetched via `getPRReviews`.
- [ ] Given the Engine Core dispatches the Implementor for an issue with a linked PR but no prior
      reviews or comments, when `getPRReviews` returns empty arrays, then the "Prior Reviews" and
      "Prior Inline Comments" sections are omitted from the prompt.
- [ ] Given the Engine Core dispatches the Implementor for an issue with a linked PR and
      `getCIStatus` returns `overall: 'failure'`, when it builds the trigger prompt, then the prompt
      includes a "CI Status: FAILURE" section listing only failed, cancelled, or timed-out check
      runs.
- [ ] Given the Engine Core dispatches the Implementor for an issue with a linked PR and
      `getCIStatus` returns `overall: 'success'`, when it builds the trigger prompt, then no "CI
      Status" section is included.
- [ ] Given any fetch fails during Implementor dispatch (issue details, PR files, review history, or
      CI status), when the error is caught, then the dispatch fails (treated as agent session
      creation failure).

### Reviewer Context Pre-computation

- [ ] Given the Engine Core dispatches the Reviewer (via completion-dispatch or manual
      `dispatchReviewer`), when it builds the trigger prompt, then the prompt includes the issue
      body and labels fetched via `getIssueDetails`.
- [ ] Given the Engine Core dispatches the Reviewer, when it builds the trigger prompt, then the
      prompt includes per-file patches fetched via `getPRFiles` using the PR number from the
      preceding `getPRForIssue` call.
- [ ] Given the Engine Core dispatches the Reviewer, when it builds the trigger prompt, then the
      prompt includes prior review submissions and inline comments fetched via `getPRReviews`.
- [ ] Given the Engine Core dispatches the Reviewer on a first-time review (no prior reviews or
      comments), when `getPRReviews` returns empty arrays, then the "Prior Reviews" and "Prior
      Inline Comments" sections are omitted from the prompt.
- [ ] Given a PR file entry has no `patch` (binary file or diff size limit exceeded), when the
      enriched prompt is built, then the file entry includes the filename and status but no code
      block.
- [ ] Given any fetch fails during Reviewer dispatch (issue details, PR files, or review history),
      when the error is caught, then the dispatch fails (treated as agent session creation failure).

## Dependencies

- [control-plane-engine-agent-manager.md](./control-plane-engine-agent-manager.md) — Parent agent
  manager spec (`QueryFactory`, session creation)
- [control-plane-engine.md](./control-plane-engine.md) — Parent engine spec (query interface:
  `getIssueDetails`, `getPRForIssue`, `getPRFiles`, `getPRReviews`, `getCIStatus`;
  `GitHubClient.repos.getContent`; deferred paths buffer for Planner dispatch failures)
- [control-plane-engine-spec-poller.md](./control-plane-engine-spec-poller.md) —
  `SpecPollerBatchResult.commitSHA` used for Planner diff computation
- [control-plane-engine-planner-cache.md](./control-plane-engine-planner-cache.md) — Cached commit
  SHA for Planner diff computation

## References

- [control-plane-engine.md: Dispatch Logic — Auto-dispatch](./control-plane-engine.md#auto-dispatch)
  — When the Planner is dispatched
- [control-plane-engine.md: Command Interface — dispatchImplementor](./control-plane-engine.md#command-interface)
  — When the Implementor is dispatched
- [control-plane-engine.md: Dispatch Logic — Completion-dispatch](./control-plane-engine.md#completion-dispatch)
  — When the Reviewer is dispatched
- [agent-planner.md](./agent-planner.md) — Planner agent definition (consumer of the enriched
  prompt)
- [agent-implementor.md](./agent-implementor.md) — Implementor agent definition (consumer of the
  enriched prompt)
- [agent-reviewer.md](./agent-reviewer.md) — Reviewer agent definition (consumer of the enriched
  prompt)
