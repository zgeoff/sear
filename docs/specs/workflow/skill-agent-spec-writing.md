---
title: Agent Spec Writing Skill
version: 0.1.0
last_updated: 2026-02-13
status: approved
---

# Agent Spec Writing Skill

## Overview

Agent skill (`/agent-spec-writing`) that provides a specialized template, section guidance, and
writing disciplines for specifying agent behavior. Produces specs that separate contract-level
content (what the agent must accomplish, its boundaries, its integration points) from prompt-level
content (how the agent executes, step-by-step instructions, command examples). The agent spec is the
document you read to understand the agent's role in the system; the agent definition
(`.claude/agents/<name>.md`) is the document the LLM reads to do its job.

## Constraints

- Agent specs live in `docs/specs/` alongside other specs
- All fixed template sections are required (see [Agent Spec Template](#agent-spec-template))
- Must invoke `/doc-coauthoring` to develop the spec through structured collaboration
- The general writing disciplines from
  [skill-spec-writing.md: Writing Disciplines](./skill-spec-writing.md#writing-disciplines) apply
  unchanged (define-once, rationale separation, structured formats, acceptance criteria discipline)
- Every normative statement has exactly one home — no duplication between the agent spec, the agent
  definition, and the shared contracts document
- The spec must not read like a system prompt rewritten in third person

## Specification

### Agent Spec Template

Agent specs follow this structure, which replaces the general spec template from
[skill-spec-writing.md](./skill-spec-writing.md). The general writing disciplines are inherited; the
template structure is not. Fixed sections are required for every agent. Agent-specific contract
sections vary per agent and must pass the Contract Test (see
[The Contract Test](#the-contract-test)).

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

When and how the agent is invoked. What event or condition causes dispatch.

## Inputs

What the agent receives at dispatch time (injected by the caller) vs. what it fetches itself via
tool calls.

## [Agent-specific contract sections]

Behavioral contracts that survive the Contract Test. Section names and structure vary per agent.
Examples: Review Checklist, Decomposition Process, Scope Enforcement, Status Transitions.

## Completion Output

What the agent returns as its final output to the invoking process. Reference the format definition
in the shared contracts document.

## Acceptance Criteria

- [ ] Given <precondition>, when <action>, then <outcome>

## Dependencies

What this agent relies on to function.

## Known Limitations

_(Optional)_ Intentional capability gaps, scale boundaries, or deferred items. Omit this section
entirely when there are none.

## References

Related specs, external docs, prior art.
```

### Section Guidance

| Section                     | Purpose                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**                | One paragraph. What the agent does, its role, what it produces. Orient the reader.                                                                                                                                                                                                                                  |
| **Constraints**             | Hard rules the agent must follow. Includes both operational constraints (tool usage, CLI wrappers) and behavioral constraints (must read full files, must not guess spec intent). Behavioral constraints that affect review quality or correctness belong here, not in a separate "how to use your inputs" section. |
| **Agent Profile**           | Design decisions for the agent's configuration, with rationale. See [Agent Profile Table](#agent-profile-table) for format.                                                                                                                                                                                         |
| **Trigger**                 | The event or condition that causes the agent to be dispatched. Reference the engine spec section that defines the trigger mechanism.                                                                                                                                                                                |
| **Inputs**                  | Two parts: (1) what the caller injects at dispatch time (the contract between engine and agent), and (2) what the agent fetches itself. The injected context is a precise data interface — enumerate each field. The self-fetched data is a summary.                                                                |
| **Agent-specific sections** | Contract-level behavioral content that varies per agent. Must pass the Contract Test. Examples: a review checklist (defines what "reviewed" means), a decomposition process (defines ordering constraints between phases), scope enforcement rules (shared between producer and auditor).                           |
| **Completion Output**       | The agent's output contract with its caller. Every agent produces final output; the format is always worth specifying. Reference the format definition in the shared contracts document.                                                                                                                            |
| **Acceptance Criteria**     | Observable behavioral outcomes. See [Acceptance Criteria for Agents](#acceptance-criteria-for-agents) for agent-specific guidance. General AC discipline from [skill-spec-writing.md: Acceptance Criteria Discipline](./skill-spec-writing.md#acceptance-criteria-discipline) applies.                              |
| **Dependencies**            | What the agent requires: CLI wrappers, shared contracts, engine specs, bash validators, external tools.                                                                                                                                                                                                             |
| **Known Limitations**       | _(Optional)_ Intentional capability gaps, scale boundaries, or deferred items. Omit entirely when there are none. Same semantics as the general template.                                                                                                                                                           |
| **References**              | Related specs and docs. Not required to function.                                                                                                                                                                                                                                                                   |

### Agent-Specific Writing Disciplines

These disciplines supplement the general writing disciplines defined in
[skill-spec-writing.md: Writing Disciplines](./skill-spec-writing.md#writing-disciplines). The
general disciplines (define-once, rationale separation, structured formats, acceptance criteria
discipline) apply unchanged. The disciplines below address concerns specific to agent specs.

#### Contract vs Prompt Separation

An agent spec defines **contracts** — what the agent must accomplish, what it produces, what
boundaries it operates within, and why. The agent definition (`.claude/agents/<name>.md`) owns the
**prompt** — step-by-step workflows, command examples, and execution instructions.

**The spec is for the person building or reviewing the agent. The agent definition is for the LLM
doing the work.**

**Belongs in the spec (contract layer):**

- Constraints and boundaries (what the agent can/cannot do, and why)
- Input/output contracts (what the engine provides, what the agent produces)
- Status transitions the agent owns
- Integration points with other agents or the engine
- Acceptance criteria (observable behavioral outcomes)
- Design rationale for key decisions

**Belongs only in the agent definition (prompt layer):**

- Step-by-step execution flows ("Step 1: Read the issue, Step 2: Validate...")
- Command examples and `gh.sh` patterns
- Numbered instructions in "you" voice
- Templates transcribed from the shared contracts document

**Indicators the spec is at the wrong altitude:**

- The spec reads like a system prompt rewritten in third person.
- The spec and agent definition have sections with substantial textual overlap.
- Removing a behavioral section from the spec would not change what an implementor builds (the
  acceptance criteria already cover it).

The spec may describe behavioral requirements that the agent definition implements as workflow
steps. The spec says "must validate inputs before starting work"; the agent definition says "Step 3:
Validate inputs — check A, B, C." The requirement is contract; the numbered steps are prompt.

Design rationale (why Sonnet, why read-only, why 50 turns) belongs in the spec. The agent definition
implements the decision without repeating the reasoning.

When in doubt about whether content is contract or prompt: would another team member need to review
and approve a change to this content? If yes, it is contract. If it is prompt tuning that does not
change observable behavior, it is prompt.

#### The Contract Test

After drafting, apply this test to each behavioral section in the spec:

**If you could delete the section and the acceptance criteria would still fully define correctness,
that section is prompt-level content, not contract.**

Corollary: if deleting a section would leave a gap that no acceptance criterion covers, that section
is earning its place in the spec — or the acceptance criteria set is incomplete.

How to apply:

1. Read the spec with each behavioral section removed one at a time.
2. For each removal, check: does an acceptance criterion cover this behavior?
3. If yes, the section is prompt (move it to the agent definition or remove it).
4. If no, either the section is contract (keep it) or the AC set needs a new criterion.

The test does not apply to structural sections (Overview, Constraints, Agent Profile, Dependencies,
References) — those are contract by nature.

Common false positive: execution flows that look important because they are detailed, but whose
behavior is fully covered by acceptance criteria. Detail does not make something a contract.

#### Agent Profile Table

The Agent Profile table captures agent configuration decisions with rationale. It replaces inline
frontmatter YAML — the spec describes intent and reasoning, not implementation syntax.

| Column     | Purpose                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------- |
| Constraint | The configuration dimension (e.g., "Model tier", "Tool access")                              |
| Value      | The decision, described in terms of intent (e.g., "No write tools (Read, Grep, Glob, Bash)") |
| Rationale  | Why this decision was made — the part the agent definition cannot tell you                   |

Standard rows (include all four for every agent):

| Constraint       | Guidance                                                          |
| ---------------- | ----------------------------------------------------------------- |
| Model tier       | Sonnet or Opus, with justification for the capability level       |
| Tool access      | Which tools and why; frame as capability boundary, not YAML field |
| Turn budget      | Upper bound with rationale for the expected workload              |
| Permission model | Interactive vs non-interactive, with safety mechanism             |

Additional rows are allowed for agent-specific constraints (e.g., "Output verbosity" for an agent
that must suppress narration).

Values describe the intent, not the YAML syntax: write "No write tools (Read, Grep, Glob, Bash)" not
"`disallowedTools: Write, Edit, NotebookEdit, ...`".

A note below the table must reference the agent definition file path and the engine spec section
that maps frontmatter fields.

#### Shared Contracts

Templates and data formats produced by one agent and consumed by another (or by humans or the
engine) are defined once in a shared contracts document (e.g., `workflow-contracts.md`). This
follows the define-once principle from
[skill-spec-writing.md: Define Once, Reference Elsewhere](./skill-spec-writing.md#define-once-reference-elsewhere).

**Extraction rule:** During drafting, if a template is produced by one agent and consumed by
another, or if two specs need to reference the same format, extract it to the contracts document.
The final state of a spec should contain only cross-references to the contracts document, never
inlined template text.

**Inlining requirement:** Agent definitions must inline the templates they use — agents do not fetch
templates via tool calls at runtime. The contracts document is the single source of truth; agent
definitions transcribe relevant templates verbatim into their prompt body. The spec and the agent
definition both reference the contracts document, but only the agent definition contains the full
template text.

**Cross-referencing:** The spec references the contracts document with a section-level
cross-reference:

```markdown
The agent posts a blocker comment using the Blocker Comment Format (see
[workflow-contracts.md: Blocker Comment Format](./workflow-contracts.md#blocker-comment-format)).
```

**Examples of shared contracts:** completion output formats, issue comment formats (blocker,
escalation, validation failure), PR review templates (approval, rejection), GitHub issue templates
(task, refinement), scope enforcement rules.

#### Acceptance Criteria for Agents

The general acceptance criteria discipline from
[skill-spec-writing.md: Acceptance Criteria Discipline](./skill-spec-writing.md#acceptance-criteria-discipline)
applies. The following additional guidance is specific to agent specs.

**Keep** criteria that test observable behavioral outcomes:

- State transitions (label changes, issue status updates)
- Output format conformance (completion output, PR review comments)
- Error handling paths (validation failure, blocker escalation)

**Keep** criteria that test cross-agent contracts:

- Output produced by one agent that another agent consumes (e.g., Planner's task issues consumed by
  Implementor)
- Shared data format conformance

**Remove** criteria that restate constraints:

- "Uses `gh.sh`" is a constraint, not a behavioral outcome. The constraint section and the bash
  validator hook enforce it.

**Remove** criteria that test configuration properties:

- Model choice, tool access, turn budget. The Agent Profile table documents these with rationale.

**Rework** criteria that test execution ordering into behavioral terms:

- "Reads spec before writing code" is a behavioral requirement (keep, rephrased).
- "Step 2 comes before step 3" is procedural (remove — that is prompt structure).

### Workflow

1. Ask clarifying questions to gather context about the agent: its role, what triggers it, what it
   produces, how it integrates with other agents or systems.
2. Determine if the agent produces or consumes shared data formats. If so, identify which templates
   belong in the shared contracts document.
3. Invoke `/doc-coauthoring` to develop the spec through structured collaboration.
4. Ensure output conforms to the agent spec template (see
   [Agent Spec Template](#agent-spec-template)).
5. Apply all writing disciplines: general disciplines from
   [skill-spec-writing.md](./skill-spec-writing.md) and agent-specific disciplines from
   [Agent-Specific Writing Disciplines](#agent-specific-writing-disciplines).
6. After drafting, apply the Contract Test (see [The Contract Test](#the-contract-test)) to every
   behavioral section. Move prompt-level content to the agent definition or remove it.
7. Before finalizing, verify:
   - No content is duplicated between the spec and the agent definition.
   - Shared templates are extracted to the contracts document, not inlined in the spec.
   - The Agent Profile table has all four standard rows with rationale.
   - Acceptance criteria test behavioral outcomes, not constraints or configuration.
   - Cross-references to the contracts document and engine specs resolve to real sections.

## Acceptance Criteria

- [ ] Given the skill is invoked, when it completes, then an agent spec file exists in
      `docs/specs/`.
- [ ] Given the output spec, when reviewed, then all fixed template sections are present: Overview,
      Constraints, Agent Profile, Trigger, Inputs, Completion Output, Acceptance Criteria,
      Dependencies, References.
- [ ] Given the output spec, when reviewed, then the Agent Profile table has four standard rows
      (Model tier, Tool access, Turn budget, Permission model) each with a Rationale column.
- [ ] Given the output spec, when reviewed, then no section contains step-by-step execution flows,
      command examples, or numbered "how-to" instructions (these belong in the agent definition).
- [ ] Given the output spec has agent-specific behavioral sections, when the Contract Test is
      applied, then each section would leave a gap in the acceptance criteria if removed.
- [ ] Given the output spec references shared data formats (completion output, issue templates,
      comment formats), when reviewed, then each format is referenced via cross-reference to the
      contracts document, not inlined.
- [ ] Given the output spec, when reviewed, then no acceptance criterion restates a constraint or
      tests a configuration property from the Agent Profile table.
- [ ] Given the skill is invoked, when developing the spec, then `/doc-coauthoring` is invoked.

## Dependencies

- `/doc-coauthoring` skill
- `skill-spec-writing.md` — General spec template, writing disciplines, and acceptance criteria
  discipline

## References

- `skill-spec-writing.md` — General spec writing skill spec
- `workflow-contracts.md` — Example shared contracts document
