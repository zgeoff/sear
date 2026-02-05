---
title: Spec Writing Skill
version: 0.1.0
last_updated: 2026-02-06
status: approved
---

# Spec Writing Skill

## Overview

Agent skill (`/spec-writing`) that provides project-specific guidance, templates, and conventions for writing specifications. Invokes `/doc-coauthoring` to develop the spec through structured collaboration.

## Constraints

- Specs must live in `docs/specs/` (subfolders allowed for logical grouping)
- Spec files use descriptive names (lowercase, hyphenated, e.g., `authentication.md`, `job-scheduler.md`)
- All template sections are required (use "None" if not applicable)
- Output must conform to the specified template structure
- Acceptance criteria must be verifiable by an agent (not subjective)
- Acceptance criteria must reference observable outcomes
- Must invoke `/doc-coauthoring` to develop the spec

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

## Dependencies

What this relies on to function.

## References

Related specs, external docs, prior art.
```

### Frontmatter Fields

| Field | Description |
|-------|-------------|
| `title` | Human-readable name |
| `version` | Semver. Bump MAJOR for breaking changes to acceptance criteria, MINOR for additions/clarifications, PATCH for typos |
| `last_updated` | ISO 8601 date (e.g., `2026-02-06`) |
| `status` | `draft` (WIP), `review` (ready for approval), `approved` (ready for implementation), `deprecated` (no longer active) |

### Section Guidance

| Section | Purpose |
|---------|---------|
| **Overview** | One paragraph. What this is, why it exists. Orient the reader. |
| **Constraints** | Hard rules. What it must/must not do. Non-negotiable. |
| **Specification** | The core details. How it works. Precise enough to implement against. Use subsections if needed. |
| **Acceptance Criteria** | Verifiable conditions for completeness. Agent must be able to confirm pass/fail. |
| **Dependencies** | What this requires to function. Other specs, skills, tools, external systems. |
| **References** | Related context. Links to other specs, external docs, prior art. Not required to function. |

### Acceptance Criteria Examples

Use Given/When/Then format. Each criterion must be verifiable by an agent with observable outcomes.

**Good examples:**

```markdown
- [ ] Given a valid spec file path, when the skill is invoked, then the output file exists in `docs/specs/`
- [ ] Given the generated spec, when reviewed, then all sections from the template are present
- [ ] Given acceptance criteria in the output, when evaluated, then each criterion references an observable outcome
- [ ] Given a spec with separable concerns (multiple distinct features), when reviewed, then the skill has advised splitting
```

**What makes these good:**
- Precondition is clear (Given)
- Action is specific (When)
- Outcome is observable and verifiable (Then)
- No subjective judgment required

### Workflow

1. Ask clarifying questions to gather context about what spec is needed
2. Invoke `/doc-coauthoring` to develop the spec through structured collaboration
3. Ensure output conforms to the template structure
4. If separable concerns exist (multiple distinct features), advise splitting into separate specs

## Acceptance Criteria

- [ ] Given the skill is invoked, when it completes, then a spec file exists in `docs/specs/` (or a subfolder)
- [ ] Given the output spec, when reviewed, then all template sections are present
- [ ] Given the output spec, when reviewed, then each acceptance criterion is verifiable by an agent
- [ ] Given the output spec, when reviewed, then each acceptance criterion references an observable outcome
- [ ] Given the skill is invoked, when developing the spec, then `/doc-coauthoring` is invoked
- [ ] Given a topic with separable concerns, when developing the spec, then splitting into separate specs is advised

## Dependencies

- `/doc-coauthoring` skill

## References

None.
