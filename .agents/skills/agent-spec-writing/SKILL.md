---
name: agent-spec-writing
description:
  Write specifications for AI agents following a specialized template that separates contract-level
  content from prompt-level content. Use when creating agent specs, specifying subagent behavior, or
  documenting agent contracts. Triggers on requests like "write an agent spec", "spec out this
  agent", "create a spec for the X agent", or "document the agent's behavior". Invokes
  /doc-coauthoring for structured collaboration.
---

# Agent Spec Writing

Write specifications for AI agents using a specialized template and writing disciplines. Agent specs
define **contracts** — what the agent must accomplish, its boundaries, and its integration points.
The agent definition (`.claude/agents/<name>.md`) owns the **prompt** — step-by-step workflows,
command examples, and execution instructions.

**The spec is for the person building or reviewing the agent. The agent definition is for the LLM
doing the work.**

## Constraints

- Agent specs live in `docs/specs/` (subfolders allowed)
- Filenames: lowercase, hyphenated (e.g., `agent-reviewer.md`)
- All fixed template sections required
- New specs start with `status: draft`
- No duplication between spec, agent definition, and shared contracts document
- The spec must not read like a system prompt rewritten in third person

## Workflow

1. Gather context: agent's role, trigger, inputs, outputs, integration points
2. Identify shared data formats — templates produced/consumed across agents go in a shared contracts
   document (e.g., `workflow-contracts.md`)
3. Invoke `/doc-coauthoring` to develop the spec
4. Conform to the agent spec template (see below)
5. Apply all writing disciplines (general and agent-specific)
6. Apply the Contract Test to every behavioral section
7. Final check: no spec/agent-definition duplication, shared templates extracted, Agent Profile
   complete, AC tests behavior not configuration, cross-references resolve

## Template

```markdown
---
title: <Agent Name> Agent
version: 0.1.0
last_updated: <ISO 8601 date>
status: draft | review | approved | deprecated
---

# <Agent Name> Agent

## Overview

What this agent does, its role in the system, and what it produces.

## Constraints

Hard boundaries. Must/must not. Behavioral constraints (e.g., "must read full files before assessing
correctness") belong here alongside operational rules (e.g., "must use gh.sh for all GitHub
operations").

## Agent Profile

| Constraint       | Value | Rationale |
| ---------------- | ----- | --------- |
| Model tier       | ...   | ...       |
| Tool access      | ...   | ...       |
| Turn budget      | ...   | ...       |
| Permission model | ...   | ...       |

## Trigger

When and how the agent is invoked.

## Inputs

What the agent receives at dispatch time (injected by the caller) vs. what it fetches itself via
tool calls.

## [Agent-specific contract sections]

Behavioral contracts that survive the Contract Test.

## Completion Output

What the agent returns as its final output to the invoking process. Reference the format in the
shared contracts document.

## Acceptance Criteria

- [ ] Given <precondition>, when <action>, then <outcome>

## Known Limitations

_(Optional)_ Intentional capability gaps. Omit entirely when none.

## Dependencies

What this agent relies on to function.

## References

Related specs, external docs, prior art.
```

## Section Guidance

| Section                     | Purpose                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Overview**                | One paragraph. Role, what it does, what it produces.                                                                                                                                 |
| **Constraints**             | Hard rules — both operational and behavioral. Behavioral constraints that affect correctness belong here, not in a "how to use your inputs" section.                                 |
| **Agent Profile**           | Configuration decisions with rationale. Four standard rows required (see below). Values describe intent, not YAML syntax. Include a note referencing the agent definition file path. |
| **Trigger**                 | Event or condition that causes dispatch. Reference the mechanism that triggers it.                                                                                                   |
| **Inputs**                  | Two parts: (1) injected context (precise data interface — enumerate fields), (2) self-fetched data (summary).                                                                        |
| **Agent-specific sections** | Contract-level content that varies per agent. Must pass the Contract Test.                                                                                                           |
| **Completion Output**       | Output contract with caller. Reference format in shared contracts doc.                                                                                                               |
| **Acceptance Criteria**     | Observable behavioral outcomes only. See AC guidance below.                                                                                                                          |
| **Dependencies**            | CLI wrappers, shared contracts, engine specs, validators, tools.                                                                                                                     |
| **References**              | Related specs and docs. Not required to function.                                                                                                                                    |

## Agent Profile Table

Four standard rows, always present:

| Constraint       | Guidance                                           |
| ---------------- | -------------------------------------------------- |
| Model tier       | Sonnet or Opus, with justification                 |
| Tool access      | Which tools and why — frame as capability boundary |
| Turn budget      | Upper bound with workload rationale                |
| Permission model | Interactive vs non-interactive, safety mechanism   |

Additional rows allowed for agent-specific constraints. Values describe intent: write "No write
tools (Read, Grep, Glob, Bash)" not "`disallowedTools: Write, Edit, ...`".

## General Writing Disciplines

### Define Once, Reference Elsewhere

Every normative behavior has exactly one home. When referencing behavior owned elsewhere:

1. One-sentence summary of **what** happens (not **how**)
2. Section-level cross-reference:
   `See [<spec-name>: <section>](./<spec-name>#<section-anchor>) for full behavior.`

Never copy procedures, tables, or step lists across specs.

### Rationale Separation

"Why" content goes in blockquote admonitions:

```markdown
> **Rationale:** Explanation of why this design decision was made.
```

**Test:** Read the spec with rationale blocks hidden — it should be complete and implementable on
its own.

### Structured Formats Over Prose

| Content Type             | Preferred Format                                |
| ------------------------ | ----------------------------------------------- |
| Procedures with branches | Numbered step lists with explicit branch points |
| Classification logic     | Decision tables                                 |
| Multi-case behavior      | Tables or labeled sub-sections                  |
| Configuration            | Tables (Setting, Type, Description, Default)    |
| Data shapes              | TypeScript type definitions in code blocks      |

Avoid paragraph-form procedures with inline conditionals.

## Agent-Specific Writing Disciplines

### Contract vs Prompt

**Belongs in the spec:**

- Constraints and boundaries (what and why)
- Input/output contracts
- Integration points with other agents
- Acceptance criteria
- Design rationale

**Belongs only in the agent definition:**

- Step-by-step execution flows
- Command examples
- Numbered "you" voice instructions
- Templates transcribed from shared contracts

**Wrong altitude indicators:**

- Spec reads like a third-person system prompt
- Substantial textual overlap between spec and agent definition
- Removing a behavioral section wouldn't change what an implementor builds

The spec says "must validate inputs before starting work." The agent definition says "Step 3:
Validate inputs — check A, B, C." The requirement is contract; the numbered steps are prompt.

### The Contract Test

After drafting, apply to each behavioral section:

**If you could delete the section and the acceptance criteria would still fully define correctness,
that section is prompt-level content.**

How to apply:

1. Remove each behavioral section one at a time
2. Check: does an AC cover this behavior?
3. If yes → prompt (move to agent definition or remove)
4. If no → contract (keep), or AC set is incomplete (add one)

Does not apply to structural sections (Overview, Constraints, Agent Profile, Dependencies,
References).

### Shared Contracts

Templates produced by one agent and consumed by another are defined once in a shared contracts
document.

**Extraction rule:** If a template is produced by one agent and consumed by another, or if two specs
reference the same format, extract it. The final spec should contain only cross-references, never
inlined template text.

**Inlining requirement:** Agent definitions must inline templates they use — agents do not fetch
templates at runtime. The contracts doc is the source of truth; agent definitions transcribe
verbatim.

**Cross-reference format:**

```markdown
(see
[workflow-contracts.md: Blocker Comment Format](./workflow-contracts.md#blocker-comment-format))
```

### Acceptance Criteria for Agents

**Criteria are for:** Edge cases, ordering guarantees, interaction effects, negative cases, error
handling paths. Not a GWT reformatting of spec prose.

**Keep** — observable behavioral outcomes: state transitions, output format conformance, error
handling, cross-agent contracts.

**Remove** — constraint restatements ("uses gh.sh") and configuration tests (model choice, tool
access). The Constraints section and Agent Profile table handle these.

**Rework** — execution ordering into behavioral terms: "reads spec before writing code" (behavioral,
keep) vs "step 2 before step 3" (procedural, remove).

**Budget:** ~30-40 acceptance criteria max per spec.
