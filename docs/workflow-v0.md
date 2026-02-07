# Development Protocol

> Governing principles and workflows for AI-led iterative development.

---

## TLDR

**Specs are source of truth.** They live in `docs/specs/`, are version-controlled, and require Human approval to change.

**Tasks are GitHub Issues.** The Planner creates them from specs. Implementors execute them. Reviewers verify them. Humans merge them.

**The flow:** Spec → Plan → Implement → Review → Integrate

**When blocked:** Stop, document the blocker with options and a recommendation, escalate. Don't guess.

**Core principles:** Correctness over speed. Seek clarification, don't assume. Stay within scope. Explain your reasoning.

---

## Principles

### Correctness

1. **Correctness over speed** — Accuracy to the specification takes priority over velocity. A correct implementation delivered later is better than a flawed one delivered sooner.

2. **Specification is source of truth** — Implementation must conform to spec. When they conflict, work stops until the spec is amended or clarification is provided.

3. **Human authority over specifications** — Only humans can approve spec changes. Agents propose amendments; humans decide.

4. **Seek clarification, don't assume** — When requirements are ambiguous or incomplete, agents must seek clarification from a human or designated agent rather than making interpretive decisions.

5. **Document all assumptions** — Any assumption an agent makes must be explicitly recorded. Assumptions are signals that the spec needs refinement — they should flow back into specifications.

6. **Testability is non-negotiable** — Acceptance criteria must be verifiable. If it can't be tested, it must be rewritten until it can be.

### Consistency

7. **Consistency with existing code** — New code should match the patterns, style, and conventions of the existing codebase. When in doubt, follow precedent.

8. **Tasks are hermetic** — A task should be completable without real-time coordination with other agents. Inputs are defined upfront; outputs are specified clearly.

9. **Explicit scope boundaries** — Every task defines what it may touch and what it must not. Agents must not modify code outside their declared scope.

10. **Minimal footprint** — Change only what's necessary to satisfy the task. Do not refactor, "improve," or modify adjacent code outside scope.

### Execution

11. **No incomplete deliverables** — Agents do not submit partial work as complete. If blocked, they stop, preserve their progress, and surface the blocker. Work can be resumed when unblocked.

12. **Fail fast, stop on blocked** — When an agent cannot proceed on a task, it stops immediately and escalates. Since Implementors work one task at a time, a blocked task means the agent stops until unblocked.

13. **Defer to the Plan** — Agents execute in the order the Plan specifies. They do not reprioritize based on their own judgment. When priority is unclear, escalate.

14. **Clean state handoffs** — When a task completes, the codebase must be in a coherent, testable state. No broken builds, no failing tests, no dangling work.

### Transparency

15. **Explain reasoning** — Agents must document *why* they made decisions, not just *what* they did. Reasoning is as important as the code.

16. **Transparent progress** — Task status must reflect reality. Agents update status as they transition (starting, blocked, completing), not retroactively.

### Quality

17. **Developer experience matters** — Code should be readable, debuggable, and maintainable. Clever solutions that sacrifice clarity are not acceptable.

18. **Defer commitment** — Avoid locking in architectural decisions, external dependencies, or API contracts until required. When two approaches are equally valid, prefer the one that preserves flexibility.

---

## Roles

### Human

The final authority. Responsible for:
- Approving all specification changes
- Assigning tasks to Implementors
- Integrating completed, reviewed work into the codebase
- Resolving disputes or ambiguities that agents cannot resolve

The Human is the only role that can approve spec amendments. Agents propose; the Human decides.

### Spec Specialist

Co-authors and maintains specifications. Responsible for:
- Drafting specifications in collaboration with the Human using the doc-coauthoring workflow
- Reviewing blocker details surfaced by Implementors
- Proposing spec amendments when implementation reveals gaps or contradictions
- Ensuring specs are precise, testable, and internally consistent

Does not approve spec changes — prepares amendments for Human approval.

Uses the **doc-coauthoring skill** for structured spec creation: context gathering → iterative refinement → reader testing.

### Planner

Analyzes work and decomposes it into executable tasks. Responsible for:
- Assessing the delta between specifications and current codebase state
- Reviewing existing GitHub Issues to identify tasks that need modification, are now irrelevant, or are duplicated by spec changes
- Closing or updating stale issues before creating new ones
- Breaking work into hermetic, well-scoped tasks
- Creating GitHub Issues for each task with proper labels and structure
- Identifying and documenting dependencies between tasks
- Sequencing and prioritizing tasks via labels and milestones

Does not assign tasks to specific Implementors — that is the Human's responsibility.

### Implementor

Executes tasks. Responsible for:
- Reading and understanding assigned task requirements
- Implementing code, tests, and documentation as specified
- Updating task status throughout execution (starting, blocked, resuming, completing)
- Surfacing blockers with detailed context (options, trade-offs, recommendations)
- Preserving progress when blocked for later resumption
- Addressing review feedback when task is `needs-changes`

Works only within declared task scope. Does not modify code outside boundaries. Does not make interpretive decisions — seeks clarification instead.

When blocked, preserves progress by opening a draft PR. This keeps work visible, reviewable, and easy to resume.

An Implementor works on one task at a time. Parallelism is achieved by running multiple Implementors, not by assigning multiple tasks to one agent.

When merge conflicts arise from parallel work, the Human invokes an Implementor to resolve them.

### Reviewer

Reviews completed work before integration. Responsible for:
- Verifying tests pass
- Checking implementation against acceptance criteria
- Evaluating code quality, readability, and maintainability
- Confirming consistency with existing codebase patterns
- Verifying spec conformance

Approves work for integration, or rejects with actionable feedback. Rejected work returns to the Implementor for revision. Always provides feedback — never rejects without explanation.

### Agent Invocation

Agents are invoked by monitoring state changes:

| Agent | Monitors | Trigger |
|-------|----------|---------|
| Planner | `docs/specs/` | Spec committed or updated |
| Reviewer | GitHub Issues | Task moves to `status:review` |
| Spec Specialist | GitHub Issues | Task moves to `status:needs-refinement` |
| Implementor | GitHub Issues | Task assigned by Human (includes initial assignment, resumption after `unblocked`, and resumption after `needs-changes`) |

Implementation (timers, webhooks, manual invocation) is outside the scope of this protocol.

---

## Artifacts

### Overview

| Artifact | Location | Purpose |
|----------|----------|---------|
| Specification | `docs/specs/*.md` | Source of truth for what to build |
| Task | GitHub Issue | Unit of work with scope and acceptance criteria |
| Plan | GitHub Issues state | Current work status, queried via `gh` CLI |

Specifications are version-controlled with the codebase. Tasks live in GitHub Issues to leverage existing tooling for tracking, assignment, and discussion.

### Specification

**Location:** `docs/specs/<name>.md`

**Naming:** Lowercase, hyphenated by feature or domain (e.g., `authentication.md`, `job-scheduler.md`).

**Frontmatter:**

```yaml
---
title: <Specification Title>
version: <semver, e.g., 1.0.0>
last_updated: <ISO 8601 date>
status: draft | review | approved | deprecated
---
```

**Structure:**

```markdown
# <Title>

## Overview
Brief description of what this specification covers and why it exists.

## <Section>
### Purpose
Why this section/feature exists.

### Constraints
Hard boundaries: must use X, cannot do Y, must integrate with Z.

### Behavior
What it does. Precise enough to implement against.

### Acceptance Criteria
- [ ] Given X, when Y, then Z
- [ ] Performance: completes in <N>ms for <M> items
- [ ] Error case: when X fails, returns/shows Y

### Dependencies
Other spec sections or specs this relies on.
```

### Task (GitHub Issue)

Tasks are GitHub Issues with structured bodies and labels for status tracking.

**Labels:**

| Category | Labels |
|----------|--------|
| Type | `task:implement`, `task:refinement`, `task:spec` |
| Status | `status:pending`, `status:in-progress`, `status:blocked`, `status:needs-refinement`, `status:unblocked`, `status:review`, `status:needs-changes`, `status:approved` |
| Priority | `priority:high`, `priority:medium`, `priority:low` |

**Issue Body Template:**

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

**Dependencies:** Use issue references in the body (e.g., "Blocked by #123") and GitHub's native linking.

**Blockers:** When blocked, add the `status:blocked` label and comment with:

```markdown
## Blocker: <Title>

**Description:** What is blocking progress.

**Options:**
1. Option A — trade-offs
2. Option B — trade-offs

**Recommendation:** Which option and why.
```

### Plan (GitHub Issues State)

The Plan is not a separate document — it's the live state of GitHub Issues.

**Query current state:**

```bash
# All open tasks
gh issue list --label "task:implement" --state open

# By status
gh issue list --label "status:in-progress"
gh issue list --label "status:blocked"
gh issue list --label "status:review"

# By priority
gh issue list --label "priority:high" --state open

# Assigned to someone
gh issue list --label "task:implement" --assignee <username>

# View specific task
gh issue view <number>
```

**Update task status:**

```bash
# Start working on a task
gh issue edit <number> --remove-label "status:pending" --add-label "status:in-progress"

# Mark as blocked
gh issue edit <number> --remove-label "status:in-progress" --add-label "status:blocked"

# Submit for review
gh issue edit <number> --remove-label "status:in-progress" --add-label "status:review"

# Mark approved (Reviewer)
gh issue edit <number> --remove-label "status:review" --add-label "status:approved"

# Close when integrated
gh issue close <number>
```

---

## Phases

### Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   ┌──────┐      ┌──────┐      ┌───────────┐      ┌────────┐        │
│   │ Spec │ ──── │ Plan │ ──── │ Implement │ ──── │ Review │ ────┐  │
│   └──────┘      └──────┘      └───────────┘      └────────┘     │  │
│       ▲                             │                 │         │  │
│       │                             │                 │         │  │
│       └─────────────────────────────┴─────────────────┘         │  │
│              (blocked / spec amendment needed)                  │  │
│                                                                 ▼  │
│                                                          ┌──────────┐
│                                                          │ Integrate│
│                                                          └──────────┘
└─────────────────────────────────────────────────────────────────────┘
```

### 1. Spec Phase

**Primary Roles:** Spec Specialist, Human

**Trigger:** New feature request, identified gap, or spec amendment needed.

**Activities:**
- Spec Specialist drafts or updates specification in collaboration with Human, using the doc-coauthoring workflow
- Spec is structured per the Specification template
- Acceptance criteria are defined and verified as testable
- Spec is reader-tested before approval (fresh agent verifies clarity)
- Human reviews and approves the specification

**Entry Criteria:**
- Clear understanding of the problem or feature
- Human available for collaboration and approval

**Exit Criteria:**
- Specification has `status: approved` in frontmatter
- Spec committed to `docs/specs/`
- All acceptance criteria are testable

### 2. Plan Phase

**Primary Role:** Planner

**Trigger:** Spec committed or updated in `docs/specs/`.

**Activities:**
- Planner reviews the spec commit
- Planner assesses delta between spec and current codebase
- Planner reviews existing GitHub Issues to identify:
  - Tasks made irrelevant by spec changes (close with explanation)
  - Tasks that need scope or criteria updates (update issue)
  - Tasks that are duplicated by new work (close as duplicate)
- Planner decomposes remaining work into hermetic tasks
- Planner creates GitHub Issues with proper structure, labels, and dependencies
- Planner sets priority labels and sequences tasks

**Entry Criteria:**
- Specification is `approved`
- Spec committed to repository

**Exit Criteria:**
- Stale or irrelevant issues closed or updated
- All new tasks created as GitHub Issues
- Dependencies documented (issue references)
- Priority labels assigned
- Tasks are ready for assignment

### 3. Implement Phase

**Primary Role:** Implementor

**Trigger:** Human assigns task to Implementor.

**Activities:**
- Implementor reads task issue and referenced spec sections
- Implementor updates issue label to `status:in-progress`
- Implementor writes code and tests per acceptance criteria
- Implementor works only within declared scope
- If blocked by spec issue: updates label to `status:needs-refinement`, adds blocker comment, opens draft PR
- If blocked by non-spec issue: updates label to `status:blocked`, adds blocker comment, opens draft PR
- On completion: opens PR, updates label to `status:review`

**Entry Criteria:**
- Task assigned to Implementor
- No unresolved blockers (issues referenced as "Blocked by #X" are closed or resolved)
- Spec sections referenced in task are `approved`

**Exit Criteria:**
- All acceptance criteria met
- Tests pass
- PR opened and linked to issue
- Issue label is `status:review`

### 4. Review Phase

**Primary Role:** Reviewer

**Trigger:** Task moves to `status:review`.

**Activities:**
- Reviewer verifies tests pass
- Reviewer checks implementation against acceptance criteria
- Reviewer evaluates code quality and consistency
- Reviewer confirms spec conformance
- If issues found: comments with feedback, updates label to `status:needs-changes`
- If approved: updates label to `status:approved`

**Entry Criteria:**
- Issue has `status:review` label
- PR exists and is linked to issue
- CI has completed

**Exit Criteria:**
- All acceptance criteria verified
- Code quality approved
- Issue label is `status:approved`

### 5. Integrate Phase

**Primary Role:** Human (Integrator)

**Trigger:** Task has `status:approved` label.

**Activities:**
- Human trusts Reviewer approval and merges PR into main branch
- Human closes the GitHub Issue
- Codebase is in clean, testable state
- If Human has feedback or disagrees with approach, feedback is addressed upstream (specs, CLAUDE.md, or protocol) rather than blocking the current PR

**Entry Criteria:**
- Issue has `status:approved` label
- PR approved by Reviewer

**Exit Criteria:**
- PR merged
- Issue closed
- No broken builds or failing tests

---

## Workflows

### Standard Flow

```
Human + Spec Specialist
         │
         ▼
   ┌───────────┐
   │   Spec    │──────────────────────────────────┐
   │  Commit   │                                  │
   └───────────┘                                  │
         │                                        │
         ▼                                        │
     Planner                                      │
         │                                        │
         ▼                                        │
   ┌───────────┐                                  │
   │  GitHub   │                                  │
   │  Issues   │                                  │
   └───────────┘                                  │
         │                                        │
         ▼                                        │
     Human assigns                                │
         │                                        │
         ▼                                        │
   Implementor                                    │
         │                                        │
         ▼                                        │
   ┌───────────┐       ┌───────────┐              │
   │    PR     │ ───── │  Review   │              │
   └───────────┘       └───────────┘              │
                            │                     │
                            ▼                     │
                    ┌───────────────┐             │
                    │   Approved?   │             │
                    └───────────────┘             │
                       │         │                │
                      Yes        No               │
                       │         │                │
                       ▼         └──► Implementor │
                     Human                        │
                       │                          │
                       ▼                          │
                ┌───────────┐                     │
                │   Merge   │                     │
                └───────────┘                     │
                       │                          │
                       └──────────────────────────┘
                          (codebase updated)
```

### Spec Amendment Flow

When an Implementor discovers a spec issue (ambiguity, contradiction, missing information):

```
Implementor hits spec issue
         │
         ▼
┌─────────────────────────────────────┐
│ 1. Stop work on affected task       │
│ 2. Update issue: status:needs-      │
│    refinement                       │
│ 3. Add blocker comment with:        │
│    - Description of issue           │
│    - Options with trade-offs        │
│    - Recommendation                 │
│ 4. Open draft PR to preserve work   │
└─────────────────────────────────────┘
         │
         ▼
   Spec Specialist
         │
         ▼
┌─────────────────────────────────────┐
│ 5. Review blocker details           │
│ 6. Research / gather context        │
│ 7. Draft spec amendment             │
│ 8. Present to Human for approval    │
└─────────────────────────────────────┘
         │
         ▼
      Human
         │
         ▼
┌─────────────────────────────────────┐
│ 9. Review amendment                 │
│ 10. Approve, reject, or modify      │
│ 11. Spec Specialist commits change  │
└─────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│ 12. Spec Specialist updates task:   │
│     status:unblocked                │
│ 13. Implementor resumes from draft  │
│     PR, converts to ready when done │
└─────────────────────────────────────┘
```

### Blocker Comment Format

When an Implementor is blocked, they add a comment to the task issue:

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

### Task Status Transitions

```
┌─────────┐
│ pending │ ◄─── Task created by Planner
└────┬────┘
     │ Assigned + started
     ▼
┌─────────────┐
│ in-progress │ ◄─────────────────────────────────────────────┐
└──────┬──────┘                                               │
       │                                                      │
       ├──────────────────────┬────────────────┐              │
       │                      │                │              │
       ▼                      ▼                ▼              │
┌─────────┐       ┌──────────────────┐   ┌─────────┐          │
│ blocked │       │ needs-refinement │   │ review  │          │
└────┬────┘       └────────┬─────────┘   └────┬────┘          │
     │                     │                  │               │
     │ Human resolves      │ Spec fixed       ├───────────┐   │
     │                     │                  │           │   │
     │                     ▼                  ▼           ▼   │
     │               ┌───────────┐      ┌──────────┐ ┌──────────────┐
     └──────────────►│ unblocked │      │ approved │ │ needs-changes│
                     └─────┬─────┘      └────┬─────┘ └───────┬──────┘
                           │                 │               │
                           │                 │               │
                           └─────────────────│───────────────┘
                                             ▼
                                        ┌────────┐
                                        │ closed │ ◄─── Merged by Human
                                        └────────┘
```

**Transition notes:**
- When resuming from `unblocked` or `needs-changes`, Implementor updates label to `in-progress`
- `needs-changes` is set by Reviewer when rejecting with feedback
- For `needs-changes`: push fixes to the existing PR, don't open a new one
- Draft PRs (opened when blocked) are converted to ready-for-review when work is complete

---

## Escalation

### When to Escalate

Agents must escalate when:

1. **Spec issue** — Ambiguity, contradiction, or gap in specification
2. **Scope conflict** — Task requires changes outside declared scope
3. **Dependency conflict** — Two tasks need to modify the same code
4. **Technical constraint** — Implementation is impossible or impractical as specified
5. **External blocker** — Waiting on external system, API, or third party
6. **Priority conflict** — Unclear which task takes precedence
7. **Judgment call** — Decision requires human input (architectural, UX, business logic)

### Escalation Process

```
Agent encounters issue
         │
         ▼
┌─────────────────────────────────────┐
│ Can another agent resolve this?     │
│ (e.g., Spec Specialist for spec     │
│  issues, Planner for priority)      │
└─────────────────────────────────────┘
         │
        Yes ──────────────────────────────┐
         │                                │
         No                               ▼
         │                     ┌─────────────────────┐
         ▼                     │ Route to agent:     │
┌─────────────────┐            │ - Spec → Specialist │
│ Escalate to     │            │ - Priority → Planner│
│ Human directly  │            └─────────────────────┘
└─────────────────┘                       │
                                          ▼
                               ┌─────────────────────┐
                               │ Agent resolves or   │
                               │ escalates to Human  │
                               └─────────────────────┘
```

### Escalation Format

When escalating via GitHub Issue comment:

```markdown
## Escalation: <Short Title>

**Type:** spec-issue | scope-conflict | dependency-conflict | technical-constraint | external-blocker | priority-conflict | judgment-call

**Description:**
Clear explanation of the issue.

**What I've Tried:**
Steps taken before escalating.

**Options:**
1. Option A — trade-offs
2. Option B — trade-offs

**Recommendation:** <if any>

**Blocked Tasks:** #123, #124 (if applicable)

**Decision Needed By:** <date, if time-sensitive>
```

### Response Expectations

| Escalation Type | First Responder |
|-----------------|-----------------|
| Spec issue | Spec Specialist |
| Scope/dependency conflict | Planner |
| Priority conflict | Human |
| Technical constraint | Human |
| External blocker | Human |
| Judgment call | Human |

Escalations are handled in priority order as capacity allows.

---

## Quality Gates

Quality gates define what must be true before transitioning between phases. Transitions are blocked if gates are not satisfied.

### Spec → Plan

| Gate | Verification |
|------|--------------|
| Spec status is `approved` | Check frontmatter |
| All acceptance criteria are testable | Manual review |
| Spec committed to repository | Git history |
| No open `task:refinement` issues for this spec | `gh issue list --label "task:refinement"` |
| Existing issues reviewed for relevance | Planner confirms |

### Plan → Implement

| Gate | Verification |
|------|--------------|
| Task issue created with required structure | Issue body check |
| Spec reference is valid and approved | Link to `docs/specs/` |
| Scope boundaries are explicit | In Scope / Out of Scope sections |
| Acceptance criteria defined | Issue body check |
| Dependencies documented | Issue references |
| Priority label assigned | Issue labels |
| Task assigned to Implementor | Issue assignee |
| Blocking tasks are resolved | Issues referenced as "Blocked by #X" are closed |

### Implement → Review

| Gate | Verification |
|------|--------------|
| All acceptance criteria addressed | Checklist in issue |
| Tests pass locally | Implementor confirmation |
| PR opened and linked to issue | PR exists |
| Changes are within declared scope | PR diff review |
| No `status:blocked` label | Issue labels |
| Code committed (no WIP state) | PR is not draft |

### Review → Integrate

| Gate | Verification |
|------|--------------|
| Tests pass in CI | CI status |
| Acceptance criteria verified by Reviewer | Review comments |
| Code quality approved | Review approval |
| Spec conformance confirmed | Reviewer check |
| `status:approved` label applied | Issue labels |
| No unresolved review comments | PR state |

### Integrate → Complete

| Gate | Verification |
|------|--------------|
| PR merged to main | Git history |
| Issue closed | Issue state |
| No broken builds | CI status on main |
| No failing tests | CI status on main |

---

## Conventions

### Spec Naming

- Lowercase, hyphenated: `job-scheduler.md`, `authentication.md`
- Name by feature or domain, not by task or ticket
- One spec per bounded concern (can reference other specs)

### Spec Versioning

- Use semantic versioning: `MAJOR.MINOR.PATCH`
- **MAJOR**: Breaking changes to acceptance criteria or behavior
- **MINOR**: New sections, additional criteria, clarifications
- **PATCH**: Typos, formatting, non-functional changes
- Update `last_updated` on every change
- Update `version` when acceptance criteria change

### Spec Status Values

| Status | Meaning |
|--------|---------|
| `draft` | Work in progress, not ready for implementation |
| `review` | Ready for Human review |
| `approved` | Approved for implementation |
| `deprecated` | No longer active, kept for reference |

### GitHub Labels

Create these labels in the repository:

**Type:**
- `task:implement` — Implementation work
- `task:refinement` — Spec clarification request
- `task:spec` — Spec writing or revision

**Status:**
- `status:pending` — Not yet started
- `status:in-progress` — Actively being worked
- `status:blocked` — Waiting on non-spec blocker resolution (Human handles)
- `status:needs-refinement` — Blocked on spec issue (Spec Specialist handles)
- `status:unblocked` — Previously blocked, now ready to resume (set by Human for non-spec blockers, Spec Specialist for spec blockers)
- `status:review` — PR submitted, awaiting review
- `status:needs-changes` — Review rejected, Implementor must address feedback
- `status:approved` — Review passed, ready to merge

**Priority:**
- `priority:high` — Do first
- `priority:medium` — Default
- `priority:low` — Do when capacity allows

### Commit Messages

Follow conventional commits format:

```
<type>(<scope>): <description>

[optional body]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation (including specs)
- `refactor`: Code change that neither fixes nor adds
- `test`: Adding or updating tests
- `chore`: Maintenance

**Spec-related commits:**
- `docs(spec): add job-scheduler specification`
- `docs(spec): update authentication acceptance criteria`

### Branch Naming

```
<type>/<issue-number>-<short-description>
```

Examples:
- `feat/123-add-google-auth`
- `fix/456-scheduler-race-condition`

### PR Conventions

- Title: `<type>(<scope>): <description>` (matches commit)
- Body: Reference the issue (`Closes #123`)
- Link PR to issue in GitHub

### Time Formats

Use ISO 8601 for all timestamps:
- Date: `2026-02-06`
- DateTime: `2026-02-06T14:30:00Z`
