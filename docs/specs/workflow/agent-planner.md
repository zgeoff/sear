---
title: Planner Agent
version: 0.3.0
last_updated: 2026-02-11
status: approved
---

# Planner Agent

## Overview

Agent that analyzes spec commits and decomposes work into executable GitHub Issues. The Planner is triggered when a specification is committed or updated in `docs/specs/`. It reviews existing issues for relevance, decomposes the spec into hermetic tasks, and creates well-structured GitHub Issues with proper labels, dependencies, and priority.

## Constraints

- Must use `scripts/workflow/gh.sh` for all GitHub CLI operations (see `skill-github-workflow.md` § Authentication for wrapper behavior).
- Do not narrate reasoning between tool calls. Output only: gate check results, issue action summaries (created/updated/closed with number and title), and the final planning summary. No exploratory commentary.

## Agent Definition Frontmatter

The agent definition file for the Planner must include the following frontmatter fields (see `control-plane-engine-agent-manager.md` § Frontmatter Field Mapping for how the Engine parses these):

```yaml
name: planner
description: Decomposes approved specs into executable GitHub Issues
model: sonnet
maxTurns: 50
tools: Read, Grep, Glob, Bash
disallowedTools: Write, Edit, NotebookEdit, WebFetch, WebSearch, Task, TaskOutput, EnterPlanMode, ExitPlanMode, AskUserQuestion, TodoWrite, Skill
permissionMode: bypassPermissions
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: scripts/workflow/validate-bash.sh
```

- **name:** Agent identifier used by the engine for dispatch and logging.
- **description:** One-line summary mapped to `AgentDefinition.description`.
- **model:** `sonnet` — the Planner decomposes specs into tasks; Sonnet is sufficient.
- **maxTurns:** `50` — upper bound on agentic turns per session.
- **tools:** Allowlist. The Planner reads the codebase and runs `gh` commands but never modifies files.
- **disallowedTools:** Denylist reinforcing the allowlist. Blocks write operations, web access, sub-agent spawning, plan mode, user interaction, and todo list management.
- **permissionMode:** `bypassPermissions` — agents run non-interactively. The engine overrides this at dispatch time, but including it ensures correct behavior when the agent is run directly via CLI.
- **hooks:** PreToolUse bash validator hook. The engine provides this programmatically at dispatch time (see `control-plane-engine-agent-manager.md` § Programmatic Hooks), but including it ensures the validator is active when the agent is run directly via CLI.

### Permitted Bash Commands

The agent definition body (system prompt) must include the full list of permitted Bash command prefixes from `agent-hook-bash-validator.md` § Allowlist Prefixes. This tells the agent which commands are available and prevents wasted turns attempting commands the validator will block. The authoritative list lives in the bash validator spec — the agent definition transcribes it verbatim.

## Specification

### Trigger

The Planner is invoked when one or more specification files are committed or updated in `docs/specs/`. The trigger mechanism (polling, webhook, manual invocation) is defined by the workflow dispatcher and is outside the scope of this spec.

The Planner receives as input an enriched prompt built by the Engine Core. When multiple specs change in the same poll cycle, they are all included in the prompt for a single invocation.

### Injected Context

The Engine Core pre-computes and injects the following data into the Planner's trigger prompt (see `control-plane-engine-agent-manager.md` § Planner Context Pre-computation for the format):

1. **Spec content:** Full content of each changed spec, including frontmatter, acceptance criteria, and dependencies. The Planner does not need to read spec files from disk — they are provided inline.
2. **Spec diffs:** For modified specs, a unified diff showing what changed since the last successful Planner run. Added specs have no diff (all content is new). The Planner does not need to run `git diff` — diffs are pre-computed by the engine.
3. **Existing GitHub Issues:** All open `task:implement` and `task:refinement` issues with number, title, labels, and body. The Planner does not need to query GitHub for existing issues — they are provided inline.
4. **Codebase state** is NOT injected. The Planner reads the current codebase via tool calls (Read, Grep, Glob) to assess what work is already done vs. what remains. This is the Planner's primary tool-use activity.

### Pre-Planning: Validate Entry Criteria

Before creating any tasks, the Planner validates the following quality gates for each input spec:

1. Spec frontmatter `status` is `approved`.
2. All acceptance criteria in the spec are testable (contain observable outcomes).
3. The spec is committed to the repository (not just local changes).
4. No open `task:refinement` issues exist for this spec.

Gates are evaluated per spec. If any single spec fails a gate, the Planner reports the failure for that spec and continues processing the remaining specs. Only specs that pass all gates proceed to decomposition.

The failure report uses the following format (one block per failed spec):

```
## Planning Gate Failure

**Spec:** docs/specs/<name>.md

### Failed Gates
- Gate 1: Spec status is `<actual status>` (required: `approved`)
- Gate 4: Open `task:refinement` issues: #12, #15

### Action Required
What must be resolved before the Planner can process this spec.
```

### Phase 1: Review Existing Issues

Before creating new issues, the Planner reviews all open issues provided in the injected context that reference any of the input specs. An issue references a spec if its body contains the spec file path in the "Spec Reference" section (e.g., `docs/specs/feature-name.md`). Issues that do not reference any of the input specs are ignored.

The Planner identifies:

1. **Irrelevant tasks:** Issues whose referenced spec section has been removed or whose work is no longer needed due to spec changes. These are closed with a comment explaining why (e.g., "Closed: spec section removed in latest update").
2. **Stale tasks:** Issues whose scope or acceptance criteria no longer match the updated spec. These are updated in place: body, labels, and acceptance criteria are revised to match the current spec.

The Planner comments on every issue it closes or modifies, explaining the reason and referencing the spec change.

### Phase 2: Assess Delta

The Planner compares the acceptance criteria across all input specs against the current codebase to determine what work remains:

1. Read each acceptance criterion across all input specs.
2. For each criterion, check whether the current codebase already satisfies it.
3. Criteria that are already satisfied do not need tasks.
4. Criteria that are not satisfied (or partially satisfied) become the basis for task decomposition.

### Phase 3: Decompose into Tasks

The Planner breaks remaining work into tasks. Each task:

- Has a single, clear objective
- Is hermetic: can be completed by one Implementor without real-time coordination
- Has explicit scope boundaries (files/modules it may and may not touch)
- Has acceptance criteria derived from the spec (subset of spec criteria, plus any implementation-specific criteria)
- References the specific spec file and section(s) it implements

#### Task Sizing

Tasks should be sized so that an Implementor can complete one in a single working session. If a spec section requires work that is too large for one task, split it into sequential tasks with explicit dependencies.

#### Complexity Assessment

For each task, the Planner assigns a complexity label that determines the Implementor's model:

- `complexity:simple` — Single-file changes, mechanical transformations, straightforward CRUD, boilerplate. The Implementor runs with Sonnet.
- `complexity:complex` — Multi-file coordination, architectural decisions, nuanced logic, non-trivial error handling. The Implementor runs with Opus.

When in doubt, prefer `complexity:complex` — the cost of under-resourcing a task (wasted turns, poor output) exceeds the cost of over-resourcing (higher token cost). See `script-label-setup.md` for label definitions and `control-plane-engine.md` § Dispatch Logic for how the engine maps complexity labels to model overrides.

Cross-spec dependencies are detected during aggregate decomposition (e.g., Task A from spec-1 depends on types defined in spec-2's tasks). These are documented using the same "Blocked by #X" mechanism as intra-spec dependencies.

#### Scope Boundaries

For each task, the Planner defines:

- **In Scope:** Files and modules the task may create or modify.
- **Out of Scope:** Files and modules explicitly excluded, with references to other task numbers that own them (e.g., "path/to/other.ts (owned by #45)").

When two tasks could reasonably touch the same file, the Planner must define clear boundaries (e.g., one task handles the type definitions, another handles the implementation).

### Phase 4: Create GitHub Issues

For each task, the Planner creates a GitHub Issue using the following template:

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

#### Labels

Each issue receives the following labels at creation:

- **Type:** `task:implement` (or `task:refinement` for spec clarification requests)
- **Status:** `status:pending`
- **Priority:** One of `priority:high`, `priority:medium`, `priority:low`
- **Complexity:** One of `complexity:simple`, `complexity:complex` (see Complexity Assessment above). Not applied to `task:refinement` issues.

#### GitHub CLI Commands

All GitHub operations use the authenticated wrapper script. The Planner's `gh` usage is limited to these write operations:

```bash
# Create a new task issue
scripts/workflow/gh.sh issue create --title "<title>" --body "<body>" --label "<label>" --label "<label>" ...

# Update an existing issue (body, labels)
scripts/workflow/gh.sh issue edit <N> --body "<body>" --add-label "<label>" --remove-label "<label>"

# Close an irrelevant or duplicate issue
scripts/workflow/gh.sh issue close <N> --reason "not planned" --comment "<reason>"

# Add a comment explaining a change
scripts/workflow/gh.sh issue comment <N> --body "<comment>"
```

#### Priority Assignment

The Planner assigns priority based on:

- `priority:high` -- Blocks other tasks or is on the critical path. Foundation work (types, core interfaces) that other tasks depend on.
- `priority:medium` -- Default. Standard implementation work with no special urgency.
- `priority:low` -- Nice-to-have, non-blocking, or can be deferred without impacting other work.

#### Dependencies

Dependencies between tasks (both within a single spec and across specs) are documented in two ways:

1. **Issue body:** Include "Blocked by #X" in the Context section when a task cannot start until another completes.
2. **Issue references:** Use GitHub issue references so dependencies are visible in the issue sidebar.

The Planner sequences tasks so that foundational work (types, interfaces, core modules) is created first and marked as `priority:high`, with dependent tasks referencing them.

#### Duplicate Closure

When a new issue supersedes an existing open issue, the Planner closes the existing issue as a duplicate with a comment referencing the new issue number. Duplicate closure happens after new issues are created so that the superseding issue number is available for the reference.

### Phase 5: Report Summary

After all issues are created (or existing issues updated/closed), the Planner outputs a summary as its final text output, returned to whatever process invoked it. When multiple specs are processed, the summary includes per-spec sections with a combined dependency graph at the end:

```
## Planning Summary

### docs/specs/<name-1>.md (v<version>)

#### Existing Issues
- Closed: #12 (irrelevant), #15 (duplicate of #20)
- Updated: #13 (scope revised)

#### New Issues Created
- #20: <title> [priority:high]
- #21: <title> [priority:medium] (blocked by #20)

### docs/specs/<name-2>.md (v<version>)

#### Existing Issues
- (none)

#### New Issues Created
- #22: <title> [priority:medium] (blocked by #20)
- #23: <title> [priority:low]

### Combined Dependency Graph
#20 → #21
#20 → #22
#21, #22 → #23
```

### Handling Spec Ambiguity

If the Planner encounters ambiguity, contradiction, or a gap in the spec that prevents task decomposition:

1. Create a `task:refinement` issue using the template below.
2. Do not create tasks that depend on the ambiguous section until the spec is clarified.
3. Continue creating tasks for unambiguous sections of the spec.

#### Refinement Issue Template

```markdown
## Ambiguity

What is ambiguous, contradictory, or missing in the spec.

## Spec Reference
- Spec: `docs/specs/<name>.md`
- Section(s): <relevant sections>
- Quote: "<relevant text from spec>"

## Options
1. **Option A** — description and trade-offs
2. **Option B** — description and trade-offs

## Recommendation
Which option and why.

## Blocked Tasks
Tasks that cannot be created until this is resolved.
```

Refinement issues receive labels `task:refinement`, `status:pending`, and a priority label. Refinement issues default to `priority:high` because they block task creation. Use `priority:medium` only if the ambiguous section does not block critical-path work.

## Acceptance Criteria

- [ ] Given a spec with `status: approved` is committed, when the Planner runs, then it produces GitHub Issues for all unsatisfied acceptance criteria
- [ ] Given a spec with `status` other than `approved`, when the Planner runs, then it stops without creating issues and reports that the spec is not approved
- [ ] Given open `task:refinement` issues exist for a spec, when the Planner runs on that spec, then it stops without creating issues and reports the blocking `task:refinement` issues
- [ ] Given an existing open issue that is superseded by a new issue, when the Planner creates the new issue, then the existing issue is closed as a duplicate with a reference to the new issue number
- [ ] Given existing open issues that reference a removed spec section, when the Planner runs on the updated spec, then those issues are closed with an explanatory comment
- [ ] Given existing open issues with outdated acceptance criteria, when the Planner runs on the updated spec, then those issues are updated to match the current spec
- [ ] Given a new spec with acceptance criteria that the codebase already satisfies, when the Planner runs, then no tasks are created for those criteria
- [ ] Given the Planner creates tasks, when each task issue is inspected, then it contains all required sections: Objective, Spec Reference, Scope (In Scope / Out of Scope), Acceptance Criteria, Context, Constraints
- [ ] Given the Planner creates tasks, when each task issue is inspected, then it has labels `task:implement`, `status:pending`, exactly one priority label, and exactly one complexity label
- [ ] Given two tasks that could touch the same file, when the Planner creates them, then their Scope sections define non-overlapping boundaries
- [ ] Given a task that depends on another task, when the task issue is inspected, then it includes "Blocked by #X" referencing the dependency
- [ ] Given the Planner creates multiple tasks, when the tasks are inspected, then foundational work (types, interfaces, core modules) is marked `priority:high`
- [ ] Given an ambiguous section in the spec, when the Planner encounters it, then it creates a `task:refinement` issue instead of guessing intent
- [ ] Given the Planner creates a `task:refinement` issue, when the issue is inspected, then it has labels `task:refinement`, `status:pending`, and exactly one priority label
- [ ] Given the Planner completes, when the summary is reviewed, then it lists all closed, updated, and newly created issues with their priorities and dependencies
- [ ] Given the Planner creates a `task:refinement` issue, when the issue is inspected, then it does not have a complexity label
- [ ] Given any GitHub CLI operation performed by the Planner, when the command is inspected, then it uses `scripts/workflow/gh.sh` (not bare `gh`)

## Dependencies

- `scripts/workflow/gh.sh` (authenticated `gh` CLI wrapper; see `docs/specs/workflow/github-cli.md`)
- `gh` CLI (authenticated with repo access)
- Label setup (all workflow labels must exist in the repository; see `script-label-setup.md`)
- Approved specification in `docs/specs/`
- Agent Bash Tool Validator — PreToolUse hook that validates all Bash commands against blocklist/allowlist before execution. Required with `permissionMode: bypassPermissions`. See `agent-hook-bash-validator.md` (rules) and `agent-hook-bash-validator-script.md` (shell implementation).
- `control-plane-engine-agent-manager.md` § Planner Context Pre-computation — Engine builds the enriched trigger prompt

## References

- Label definitions: `docs/specs/workflow/script-label-setup.md`
- GitHub Workflow Skill: `docs/specs/workflow/skill-github-workflow.md` (reference for `gh` command patterns and label rules; not loaded at runtime)
- `control-plane-engine.md` § Dispatch Logic — Planner auto-dispatch and complexity-based model override
