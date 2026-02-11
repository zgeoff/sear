---
title: Spec Writing Skill
version: 0.3.0
last_updated: 2026-02-12
status: approved
---

# Spec Writing Skill

## Overview

Agent skill (`/spec-writing`) that provides project-specific guidance, templates, writing
disciplines, and conventions for writing and refining specifications. Invokes `/doc-coauthoring` to
develop the spec through structured collaboration. The audience for all specifications is strictly
AI agents — specs must be optimized for machine consumption: high signal density, unambiguous
normative text, and structured formats over prose.

## Constraints

- Specs must live in `docs/specs/` (subfolders allowed for logical grouping)
- Spec files use descriptive names (lowercase, hyphenated, e.g., `authentication.md`,
  `job-scheduler.md`)
- All template sections are required except Known Limitations, which is omitted when not applicable
  (never include it with "None")
- New specs start with `status: draft` in frontmatter
- Output must conform to the specified template structure
- Acceptance criteria must be verifiable by an agent (observable outcomes, no subjective judgment)
- Must invoke `/doc-coauthoring` to develop the spec
- Every normative statement must have exactly one home across the spec corpus — no cross-spec
  duplication of normative content

## Specification

### Template

All specs follow this structure:

```markdown
---
title: <Title>
version: 0.1.0
last_updated: <ISO 8601 date>
status: draft | review | approved | deprecated
---

# <Title>

## Overview

What this is and why it exists.

## Constraints

Hard boundaries. Must/must not. Non-negotiable rules.

## Specification

The core details. What it does, how it works. Precise enough to implement against.

## Acceptance Criteria

- [ ] Given <precondition>, when <action>, then <outcome>

## Known Limitations

Intentional capability gaps, scale boundaries, or deferred items. Include only when applicable —
omit this section entirely otherwise.

## Dependencies

What this relies on to function.

## References

Related specs, external docs, prior art.
```

### Frontmatter Fields

| Field          | Description                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `title`        | Human-readable name                                                                                                  |
| `version`      | Semver. Bump MAJOR for breaking changes to acceptance criteria, MINOR for additions/clarifications, PATCH for typos  |
| `last_updated` | ISO 8601 date (e.g., `2026-02-06`)                                                                                   |
| `status`       | `draft` (WIP), `review` (ready for approval), `approved` (ready for implementation), `deprecated` (no longer active) |

### Section Guidance

| Section                 | Purpose                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Overview**            | One paragraph. What this is, why it exists. Orient the reader.                                                                                                                                                                             |
| **Constraints**         | Hard rules. What it must/must not do. Non-negotiable.                                                                                                                                                                                      |
| **Specification**       | Normative content only. How it works. Precise enough to implement against. Use subsections, tables, and step lists. Rationale must be separated (see [Writing Disciplines: Rationale Separation](#rationale-separation)).                  |
| **Acceptance Criteria** | Edge cases, ordering guarantees, interaction effects, and boundary conditions that are not obvious from the Specification section. Not a restatement of the prose.                                                                         |
| **Known Limitations**   | _(Optional)_ Intentional capability gaps, scale boundaries, workarounds, or deferred-to-future-version caveats. Only include this section when the spec has limitations worth calling out. Omit entirely (not "None") when there are none. |
| **Dependencies**        | What this requires to function. Other specs, skills, tools, external systems.                                                                                                                                                              |
| **References**          | Related context. Links to other specs, external docs, prior art. Not required to function.                                                                                                                                                 |

### Writing Disciplines

These rules govern how spec content is written. They apply to all new specs and to revisions of
existing specs.

#### Define Once, Reference Elsewhere

Every normative behavior must have exactly one home in the spec corpus. When another spec needs to
mention a behavior owned by a different spec:

1. Write a one-sentence summary of **what** happens (not **how**).
2. Add a section-level cross-reference:
   `See [spec-name: Section](./spec-name.md#section-anchor) for full behavior.`

Do not copy procedures, tables, or step lists into referencing specs. If you find yourself writing
more than two sentences about a behavior that has a normative home elsewhere, you are duplicating.

**Choosing the normative home:** The most specific spec that owns the implementation. A parent spec
does not own behavior that a child or sub-spec specifies in detail.

#### Parent/Child Layering

When specs have a parent/child or parent/sub-spec relationship:

**Parent spec contains:**

- Architectural decisions and constraints
- Interface contracts between modules
- Cross-cutting classification tables (e.g., dispatch tiers)
- Technology choices
- Summary references to child/sub-spec content

**Parent spec does not contain:**

- Implementation procedures (step-by-step "how")
- Detailed type definitions that belong to a child module
- Acceptance criteria that test child-spec behavior

**Rule of thumb:** If a parent spec section has a corresponding child/sub-spec section that covers
the same topic, the parent should contain only a summary and a cross-reference. The child owns the
detail.

#### Rationale Separation

Specification sections must contain normative text — statements that an implementor acts on.
Explanatory "why" content must be visually separated using a blockquote admonition:

```markdown
> **Rationale:** Octokit's generic types don't structurally match a narrow interface, so each
> adapter method explicitly delegates to bridge the type gap.
```

**Guidelines:**

- If removing a paragraph would not change what an implementor builds, it is rationale — mark it.
- Keep rationale concise: one or two sentences.
- Place the rationale block immediately after the normative statement it explains.
- Multi-paragraph design discussions do not belong in the Specification section — move them to a
  non-normative design document or remove them.

**Test:** Read the Specification section with all rationale blocks hidden. It should be a complete,
implementable specification on its own.

#### Structured Formats Over Prose

AI agents parse structured formats more reliably than dense paragraphs. Use the most structured
format appropriate for the content:

| Content Type                         | Preferred Format                                         |
| ------------------------------------ | -------------------------------------------------------- |
| Procedures with conditional branches | Numbered step lists with explicit branch points          |
| Classification logic (if X → Y)      | Decision tables                                          |
| Multi-case behavior                  | Tables or labeled sub-sections                           |
| Configuration options                | Tables with columns: Setting, Type, Description, Default |
| Event/command catalogs               | Tables                                                   |
| Data shapes                          | TypeScript type definitions in fenced code blocks        |

**Avoid:** Paragraph-form procedures with inline conditionals. Convert to step lists.

**Example — bad:**

```markdown
When the Agent Manager reports an Implementor completed event, the Engine Core calls getPRForIssue.
If a PR is found, it sets status:review, updates the snapshot, emits a synthetic event, and
dispatches the Reviewer. If no PR is found, it takes no action and crash recovery handles the issue.
```

**Example — good:**

```markdown
When the Agent Manager reports an Implementor `agentCompleted` event:

1. Call `getPRForIssue(issueNumber, { includeDrafts: false })`.
2. **PR found:**
   - Set `status:review` on the issue via `GitHubClient`.
   - Update the IssuePoller snapshot entry to `status:review`.
   - Emit a synthetic `issueStatusChanged` event (`isEngineTransition: true`).
   - Dispatch the Reviewer.
3. **No PR found:**
   - No action. The issue remains `status:in-progress`.
   - Crash recovery detects this and resets to `status:pending`.
```

### Acceptance Criteria Discipline

#### What Criteria Are For

Acceptance criteria test behaviors that are **not obvious** from the Specification section:

- Edge cases and boundary conditions
- Ordering guarantees between events or operations
- Interaction effects across subsystems
- Negative cases (things that should NOT happen)
- Error handling paths

#### What Criteria Are Not For

Acceptance criteria are **not** a GWT reformatting of the spec prose. If a criterion restates a
sentence from the Specification section without adding edge case or boundary testing, delete it.

**Test:** For each criterion, find the prose it corresponds to. If the criterion says the same thing
as the prose (just in GWT format), it is redundant.

#### Budget

A single spec should have no more than ~30-40 acceptance criteria. If a spec needs more, it should
be further decomposed into sub-specs.

#### No Parent-Child Duplication

If a parent spec delegates a topic to a child/sub-spec ("See sub-spec for criteria"), the parent
must not have inline criteria for the same topic. Choose one home per criterion.

#### Format

Use Given/When/Then. Each criterion must be verifiable with observable outcomes.

```markdown
- [ ] Given <precondition>, when <action>, then <outcome>
```

**Good examples:**

```markdown
- [ ] Given a stale cache re-fetch fails, when the failure occurs, then the stale data is retained
      and the cache remains stale for the next view attempt.
- [ ] Given an agent is running for issue N, when issue N is removed from the poll results, then the
      agent session is cancelled and agentFailed is emitted before issueRemoved.
- [ ] Given deferred spec paths include a path whose status changed to non-approved, when the merged
      set is dispatched, then the non-approved path is dropped.
```

**Bad examples (restatement):**

```markdown
- [ ] Given the engine starts, when initialization completes, then the TUI renders. (restates prose)
- [ ] Given getPRForIssue is called, when a linked PR exists, then it returns the PR details.
      (restates the function's specification)
```

### Workflow

1. Ask clarifying questions to gather context about what spec is needed.
2. Determine if this spec is a standalone spec or part of a parent/child hierarchy. If part of a
   hierarchy, identify the parent and establish what content belongs at each level.
3. Invoke `/doc-coauthoring` to develop the spec through structured collaboration.
4. Ensure output conforms to the template structure.
5. Apply all writing disciplines: define-once, rationale separation, structured formats, acceptance
   criteria discipline.
6. If separable concerns exist (multiple distinct features that could be implemented independently),
   advise splitting into separate specs.
7. Before finalizing, verify:
   - No content is duplicated from another spec (check normative homes).
   - All rationale is in blockquote admonitions.
   - Procedures use step lists, not paragraph form.
   - Acceptance criteria are non-redundant with prose.
   - Cross-references resolve to real sections.

## Acceptance Criteria

- [ ] Given the skill is invoked, when it completes, then a spec file exists in `docs/specs/` (or a
      subfolder).
- [ ] Given the output spec, when reviewed, then all template sections are present.
- [ ] Given the output spec, when reviewed, then each acceptance criterion is verifiable by an agent
      with an observable outcome.
- [ ] Given the output spec, when reviewed, then no acceptance criterion is a GWT rephrasing of a
      sentence in the Specification section.
- [ ] Given the output spec, when reviewed, then no normative content is duplicated from another
      spec — behaviors owned by other specs are referenced with a one-sentence summary and a
      cross-reference.
- [ ] Given the output spec has rationale content, when reviewed, then all rationale is in
      `> **Rationale:** ...` blockquote admonitions.
- [ ] Given the output spec describes procedures, when reviewed, then procedures use numbered step
      lists with explicit branch points (not paragraph form).
- [ ] Given the output spec is part of a parent/child hierarchy, when reviewed, then the parent
      contains only architectural scope and the child contains implementation detail (no overlap).
- [ ] Given the skill is invoked, when developing the spec, then `/doc-coauthoring` is invoked.
- [ ] Given a topic with separable concerns, when developing the spec, then splitting into separate
      specs is advised.

## Dependencies

- `/doc-coauthoring` skill

## References

None.
