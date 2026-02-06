# Comment and Body Templates

Templates used by workflow agents when creating issues, PRs, and comments.

## Issue Body Template (Planner)

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

## Blocker Comment Template (Implementor)

Post on the task issue when work is blocked.

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

## Escalation Comment Template (Implementor)

Post on the task issue when escalation is needed.

```markdown
## Escalation: <Short Title>

**Type:** <escalation type>

**Description:**
<clear explanation>

**What I've Tried:**
<steps taken before escalating>

**Options:**
1. <option> -- <trade-offs>
2. <option> -- <trade-offs>

**Recommendation:** <if any>

**Blocked Tasks:** <issue references or "None">

**Decision Needed By:** <date or "No deadline">
```

## PR Body

PR body must contain `Closes #<issueNumber>` for automatic issue closing.

## PR Branch Naming

`<type>/<issue-number>-<short-description>`

## PR Title

Conventional commit format: `<type>(<scope>): <description>`
