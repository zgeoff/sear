---
title: Agent Hook — Bash Validator (Shell Script)
version: 0.1.1
last_updated: 2026-02-11
status: approved
---

# Agent Hook — Bash Validator (Shell Script)

## Overview

Shell script implementation of the Bash Validator hook. This script is consumed by workflow agents
via their agent definition frontmatter for interactive use (agents launched by a human outside the
control plane). The validation rules (blocklist patterns, allowlist prefixes, command segmentation,
evaluation order) are defined in `agent-hook-bash-validator.md` — this spec covers only the
shell-specific implementation details.

For control plane agent sessions, the engine provides a TypeScript implementation of the same rules
via the SDK's `hooks` option. See
[control-plane-engine-agent-manager.md: Programmatic Hooks](./control-plane-engine-agent-manager.md#programmatic-hooks).

## Constraints

- Exit code 2 is reserved for intentional blocks. The script must not exit 2 for internal errors
  (e.g., missing `jq`, malformed JSON).
- The script has no runtime dependencies beyond `bash` (4.0+), `grep`, `sed`, `awk`, and `jq`.

## Specification

### File Location

The validator script lives at `scripts/workflow/validate-bash.sh`. It is executable.

### Hook Contract

The validator is consumed as a Claude Code `PreToolUse` hook scoped to the `Bash` tool. Claude Code
invokes it before each Bash tool call, passing JSON on stdin:

```json
{
  "tool_name": "Bash",
  "tool_input": {
    "command": "<the command string>"
  }
}
```

The script extracts the command from `tool_input.command` using `jq`. The `jq` invocation must be
error-trapped so that a `jq` failure (malformed JSON, missing `jq` binary) exits 1, not whatever
exit code `jq` returns. This is required because `jq` can exit 2 on usage errors, which would be
misinterpreted as an intentional block. If the field is missing or empty, the script exits 0
(allow).

### Exit Codes

| Code | Meaning      | Behavior                                                                                                     |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `0`  | Allow        | Command proceeds to execution                                                                                |
| `1`  | Script error | Validator itself failed (e.g., `jq` not installed, malformed input). Must NOT be used for intentional blocks |
| `2`  | Block        | Command is rejected. Error message on stderr is fed back to the agent                                        |

The script must not exit 2 for internal errors. Exit 2 is reserved exclusively for commands that
fail validation.

### Validation Logic

The script implements the two-layer validation defined in `agent-hook-bash-validator.md`:

1. **Blocklist** — A quote-masked copy of the command is produced (see
   [agent-hook-bash-validator.md: Quote Masking](./agent-hook-bash-validator.md#quote-masking)) by
   replacing the contents of single- and double-quoted strings with spaces, preserving quote
   delimiters. The masking can be performed with `awk` or `sed` using the same quoting semantics as
   the segmentation parser. Each pattern from the blocklist table is then matched against this
   masked string using `grep -qE`. If any pattern matches, exit 2 with the error message format from
   the core spec.
2. **Allowlist** — The original (unmasked) command is segmented using the quote-aware parser defined
   in the core spec (implemented in `awk`). Each segment's first word is checked against the
   allowlist prefixes table. If any segment's first word is unrecognized, exit 2.

The core spec defines: blocklist patterns, allowlist prefixes, command segmentation rules,
evaluation order, empty command handling, error message format, and known limitations. This script
implements those rules — it does not define them.

### Integration

Workflow agents consume this validator by declaring it in their agent definition frontmatter:

```yaml
permissionMode: bypassPermissions
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: scripts/workflow/validate-bash.sh
```

The `permissionMode: bypassPermissions` setting allows the agent to operate autonomously. The
`PreToolUse` hook ensures every Bash invocation is validated before execution, providing the safety
net that `bypassPermissions` alone does not.

### Test Suite

The validator has a BATS test suite at `scripts/workflow/validate-bash.test.sh`. The test file
exercises every acceptance criterion in this spec and the core spec. See
[Bash Testing](../repo/bash-testing.md) for BATS installation and test runner details.

The test file defines a `run_validator` helper function that constructs the JSON envelope expected
by the hook contract and pipes it to the validator on stdin. The helper accepts a raw command
string, wraps it in `{"tool_name":"Bash","tool_input":{"command":"<command>"}}` using `jq --arg` for
safe JSON encoding (handles quotes, backslashes, newlines), and invokes the validator. Tests assert
against `$status` (exit code) and `$output` (combined stdout/stderr captured by BATS `run`). This is
sufficient for verifying error message content because the validator writes nothing to stdout — all
block messages go to stderr, and allowed commands produce no output at all.

Each acceptance criterion maps to one or more `@test` blocks. Tests are grouped by comment headers
matching the acceptance criteria categories. The "Script Errors" tests that verify behavior when
`jq` is unavailable simulate the missing binary by temporarily overriding `PATH` to exclude `jq`
within the test.

## Acceptance Criteria

All acceptance criteria from `agent-hook-bash-validator.md` apply to this implementation. The
criteria below are specific to the shell script.

### Script Errors

- [ ] Given a malformed JSON input (e.g., invalid JSON on stdin), when the script runs, then it
      exits 1 (not 2).
- [ ] Given that `jq` is not available on the system, when the script runs, then it exits 1 (not 2).

### Exit Code Mapping

- [ ] Given a command that is allowed by the validator, when the script runs, then it exits 0.
- [ ] Given a command that is blocked by the validator, when the script runs, then it exits 2 and
      the error message is written to stderr.

### Test Suite

- [ ] Given the test file `scripts/workflow/validate-bash.test.sh`, when `yarn test:sh` is run, then
      all tests pass.
- [ ] Given the acceptance criteria in this spec and `agent-hook-bash-validator.md`, when the test
      file is reviewed, then every criterion has a corresponding `@test` block.

## Dependencies

- **bash** (4.0+): Script runtime. Required for arrays, process substitution (`<(...)`), and
  `read -d ''` (null-delimited reading).
- **grep**: Pattern matching for blocklist validation (`grep -qE`).
- **sed**: Whitespace trimming during first-word extraction.
- **awk**: Quote-aware command segmentation and first-word extraction from command segments.
- **jq**: Extracts `tool_input.command` from the JSON input on stdin.
- `agent-hook-bash-validator.md` — Normative validation rules (blocklist, allowlist, segmentation,
  evaluation order).
- **Claude Code PreToolUse hooks**: The hook mechanism that invokes this script before each Bash
  tool call. See [Claude Code hooks](https://code.claude.com/docs/en/hooks).
- [Bash Testing](../repo/bash-testing.md): BATS installation, test runner, and CI integration.

## References

- `agent-hook-bash-validator.md` — Core validation rules
- [Claude Code hooks: PreToolUse event](https://code.claude.com/docs/en/hooks)
- Agent definitions: `.claude/agents/implementor.md`, `.claude/agents/planner.md`,
  `.claude/agents/reviewer.md`
