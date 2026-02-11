---
name: spec-writing
description:
  Write project specifications following standard templates, writing disciplines, and conventions.
  Use when creating specs, technical specifications, feature specs, or system design documents.
  Triggers on requests like "write a spec for X", "create a specification", "spec out this feature",
  or "document the requirements for Y". Invokes /doc-coauthoring for structured collaboration.
---

# Spec Writing

Write specifications for this project using a standard template, writing disciplines, and
conventions. The audience for all specifications is strictly AI agents — optimize for machine
consumption: high signal density, unambiguous normative text, and structured formats over prose.

## Constraints

- Specs live in `docs/specs/` (subfolders allowed for logical grouping)
- Filenames: lowercase, hyphenated (e.g., `authentication.md`, `job-scheduler.md`)
- All template sections required except Known Limitations, which is omitted when not applicable
  (never include it with "None")
- Acceptance criteria must be verifiable by an agent (observable outcomes, no subjective judgment)
- New specs start with `status: draft`
- Every normative statement has exactly one home across the spec corpus — no cross-spec duplication

## Workflow

1. Ask clarifying questions to gather context about what spec is needed
2. Determine if this spec is standalone or part of a parent/child hierarchy — if part of a
   hierarchy, identify the parent and establish what content belongs at each level
3. Invoke `/doc-coauthoring` to develop the spec through structured collaboration
4. Ensure output conforms to the template structure
5. Apply all writing disciplines (see below)
6. If separable concerns exist (multiple distinct features that could be implemented independently),
   advise splitting into separate specs
7. Before finalizing, verify: no duplication from other specs, all rationale in blockquotes,
   procedures use step lists, criteria are non-redundant with prose, cross-references resolve

## Template

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

## Frontmatter

| Field          | Description                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `title`        | Human-readable name                                                                                                  |
| `version`      | Semver. MAJOR for breaking changes to acceptance criteria, MINOR for additions/clarifications, PATCH for typos       |
| `last_updated` | ISO 8601 date (e.g., `2026-02-06`)                                                                                   |
| `status`       | `draft` (WIP), `review` (ready for approval), `approved` (ready for implementation), `deprecated` (no longer active) |

## Section Guidance

| Section                 | Purpose                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**            | One paragraph. What this is, why it exists. Orient the reader.                                                                                                                     |
| **Constraints**         | Hard rules. What it must/must not do. Non-negotiable.                                                                                                                              |
| **Specification**       | Normative content only. Precise enough to implement against. Rationale must be separated into blockquote admonitions. Use subsections, tables, and step lists.                     |
| **Acceptance Criteria** | Edge cases, ordering guarantees, interaction effects, and boundary conditions not obvious from the Specification section. Not a restatement of prose. Budget: ~30-40 max per spec. |
| **Known Limitations**   | _(Optional)_ Intentional capability gaps, scale boundaries, workarounds, or deferred items. Include only when applicable — omit entirely otherwise.                                |
| **Dependencies**        | What this requires to function. Other specs, skills, tools, external systems.                                                                                                      |
| **References**          | Related context. Links to other specs, external docs, prior art. Not required to function.                                                                                         |

## Writing Disciplines

### Define Once, Reference Elsewhere

Every normative behavior has exactly one home in the spec corpus. When another spec needs to mention
a behavior owned elsewhere:

1. Write a one-sentence summary of **what** happens (not **how**).
2. Add a section-level cross-reference:
   `See [<Spec Name>: <Section>](./<spec-name>#<section-anchor>) for full behavior.`

Do not copy procedures, tables, or step lists. If you're writing more than two sentences about a
behavior with a normative home elsewhere, you are duplicating.

### Parent/Child Layering

**Parent specs contain:** Architectural decisions, interface contracts, cross-cutting classification
tables, technology choices, summary references to child content.

**Parent specs do NOT contain:** Implementation procedures, detailed type definitions, acceptance
criteria that test child-spec behavior.

**Rule:** If a parent section has a corresponding child section, the parent has only a summary +
cross-reference. The child owns the detail.

### Rationale Separation

"Why" content must be in blockquote admonitions, visually distinct from normative "what" text:

```markdown
> **Rationale:** Explanation of why this design decision was made.
```

**Test:** Read the Specification with rationale blocks hidden. It should be a complete,
implementable spec on its own.

### Structured Formats Over Prose

| Content Type             | Preferred Format                                |
| ------------------------ | ----------------------------------------------- |
| Procedures with branches | Numbered step lists with explicit branch points |
| Classification logic     | Decision tables                                 |
| Multi-case behavior      | Tables or labeled sub-sections                  |
| Configuration            | Tables (Setting, Type, Description, Default)    |
| Data shapes              | TypeScript type definitions in code blocks      |

Avoid paragraph-form procedures with inline conditionals.

### Acceptance Criteria Discipline

**Criteria are for:** Edge cases, ordering guarantees, interaction effects, negative cases, error
handling paths.

**Criteria are NOT for:** GWT reformatting of spec prose. If a criterion says the same thing as a
prose sentence, delete it.

**No parent-child duplication.** If a parent delegates to a sub-spec ("See sub-spec for criteria"),
the parent has no inline criteria for that topic.

## Acceptance Criteria Format

Use Given/When/Then. Each criterion must be verifiable with observable outcomes.

**Good examples:**

```markdown
- [ ] Given a stale cache re-fetch fails, when the failure occurs, then the stale data is retained
      and the cache remains stale
- [ ] Given an agent is running for issue N, when issue N is removed, then agentFailed is emitted
      before issueRemoved
```

**Bad examples (restatement of prose):**

```markdown
- [ ] Given the engine starts, when initialization completes, then the TUI renders
- [ ] Given getPRForIssue is called, when a linked PR exists, then it returns PR details
```

**Avoid:**

- "Given X, when reviewed, then it is well-written" (subjective)
- "Given X, when tested, then it works correctly" (vague)
