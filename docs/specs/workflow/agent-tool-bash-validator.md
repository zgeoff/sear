---
title: Agent Bash Tool Validator
version: 0.2.0
last_updated: 2026-02-08
status: approved
---

# Agent Bash Tool Validator

## Overview

Workflow agents (Implementor, Planner, Reviewer) run with `permissionMode: bypassPermissions` to operate autonomously. This removes all interactive permission prompts but also removes all guardrails on the Bash tool — an agent could execute any shell command without restriction. The Agent Bash Tool Validator is a `PreToolUse` hook that restores safety by validating every Bash command against a two-layer filter (blocklist of dangerous patterns, allowlist of permitted command prefixes) before execution.

## Constraints

- The script is a pure validation gate. It must not modify files, produce side effects, or execute the command itself.
- The script must fail closed. False rejections (blocking a safe command) are acceptable; false allows (permitting a dangerous command) are not.
- Blocklist evaluation must always precede allowlist evaluation. This order is non-negotiable.
- Exit code 2 is reserved for intentional blocks. The script must not exit 2 for internal errors (e.g., missing `jq`, malformed JSON).
- A single shared script serves all workflow agents. Per-agent customization is not supported — agent-level differentiation is handled by the `tools` field in each agent's frontmatter, not by the validator.

## Specification

### File Location

The validator script lives at `scripts/workflow/validate-bash.sh`. It is executable and has no runtime dependencies beyond `bash` (4.0+), `grep`, `sed`, `awk`, and `jq`.

### Hook Contract

The validator is consumed as a Claude Code `PreToolUse` hook scoped to the `Bash` tool. Claude Code invokes it before each Bash tool call, passing JSON on stdin:

```json
{
  "tool_name": "Bash",
  "tool_input": {
    "command": "<the command string>"
  }
}
```

The script extracts the command from `tool_input.command` using `jq`. The `jq` invocation must be error-trapped so that a `jq` failure (malformed JSON, missing `jq` binary) exits 1, not whatever exit code `jq` returns. This is required because `jq` can exit 2 on usage errors, which would be misinterpreted as an intentional block. If the field is missing or empty, the script exits 0 (allow).

### Exit Codes

| Code | Meaning | Behavior |
|------|---------|----------|
| `0` | Allow | Command proceeds to execution |
| `1` | Script error | Validator itself failed (e.g., `jq` not installed, malformed input). Must NOT be used for intentional blocks |
| `2` | Block | Command is rejected. Error message on stderr is fed back to the agent |

The script must not exit 2 for internal errors. Exit 2 is reserved exclusively for commands that fail validation.

### Evaluation Order

Validation runs in two layers, strictly in this order:

1. **Blocklist** — checked first. A blocklist match immediately exits 2, regardless of whether the command prefix is allowlisted.
2. **Allowlist** — checked second. Every command segment must start with a recognized prefix.

This order is mandatory. Blocklist-first ensures that a dangerous command (e.g., `git reset --hard`) is always rejected even though its prefix (`git`) is allowlisted.

### Layer 1: Blocklist

The blocklist is a set of POSIX Extended Regular Expression (ERE) patterns. Each pattern is matched against the **full command string** (before segmentation) using `grep -qE`. Matching is case-sensitive.

If any pattern matches, the command is blocked.

#### Blocklist Patterns

Force pushing is not blocked by this validator. Branch protection rules are the appropriate mechanism for preventing force pushes to protected branches.

| Category | Pattern | Blocks |
|----------|---------|--------|
| Git destructive | `git\s+reset\s+--hard` | Hard reset |
| Git destructive | `git\s+clean\s+-[a-zA-Z]*f` | Clean with force |
| Git destructive | `git\s+checkout\s+\.` | Discard all working changes |
| Git destructive | `git\s+restore\s+\.` | Discard all working changes |
| Git destructive | `git\s+branch\s+.*-D\b` | Force-delete branch |
| File deletion | `rm\s` | Any `rm` invocation |
| Privilege escalation | `\bsudo\b` | Any `sudo` usage |
| Remote code execution | `curl\s.*\|\s*(bash|sh|zsh)` | Piping downloads to shell |
| Remote code execution | `wget\s.*\|\s*(bash|sh|zsh)` | Piping downloads to shell |
| Remote code execution | `\beval\b` | Eval execution |
| System modification | `\bdd\s+if=` | Disk dump |
| System modification | `\bmkfs\b` | Filesystem creation |
| System modification | `\bfdisk\b` | Partition management |
| System modification | `chmod\s+-R` | Recursive permission change |
| System modification | `chmod\s+777` | World-writable permissions |
| System modification | `chmod\s+.*o\+w` | Other-write permission |
| System modification | `chmod\s+.*a\+w` | All-write permission |
| System modification | `\bchown\b` | Ownership change |
| Process management | `\bkill\b` | Kill process |
| Process management | `\bpkill\b` | Kill by name |
| Process management | `\bkillall\b` | Kill all by name |

### Layer 2: Allowlist

If the command passes the blocklist, every segment of the command is checked against the allowlist. A segment's **first word** must exactly match an entry in the allowlist. If any segment's first word is not recognized, the command is blocked.

The first word is extracted from the **first line** of the segment by trimming leading whitespace and taking the first whitespace-delimited token. Only the first line is considered because segments may contain embedded newlines from quoted strings spanning multiple lines. Empty segments (no non-whitespace content) are skipped.

#### Command Segmentation

The command string is split into segments on these operators: `&&`, `||`, `;`, `|`, and newlines.

Splitting is quote-aware. Operators inside single-quoted (`'...'`) or double-quoted (`"..."`) strings are not treated as segment separators. Backslash escapes are respected outside quotes and inside double-quoted strings (e.g., `\"` does not close the quoted context). Single-quoted strings are literal — backslashes have no special meaning inside them, consistent with bash quoting rules.

The parser walks the command string character by character, tracking whether it is inside a quoted context. When a segment separator is encountered outside a quoted context, the current segment is emitted and a new one begins. Two-character operators (`&&`, `||`) are checked before single-character operators (`|`) to avoid incorrect splitting.

Subshell expressions (`$(...)`, backticks) are not parsed. An operator inside a subshell that is not also inside a quoted string is incorrectly treated as a segment separator. This is a safe failure mode (false rejection).

#### Allowlist Prefixes

| Category | Prefixes |
|----------|----------|
| GitHub & Git | `gh`, `git`, `scripts/workflow/gh.sh`, `./scripts/workflow/gh.sh` |
| Node.js ecosystem | `yarn` |
| Text processing | `cat`, `head`, `tail`, `grep`, `rg`, `awk`, `sed`, `tr`, `cut`, `sort`, `uniq`, `wc`, `jq`, `xargs` |
| Shell utilities | `echo`, `printf`, `ls`, `pwd`, `which`, `command`, `test`, `true`, `false`, `env`, `date`, `basename`, `dirname`, `realpath` |
| File operations | `chmod` (subject to blocklist restrictions), `mkdir`, `touch` |

### Error Message Format

When a command is blocked, the script writes a message to stderr. The message must identify which layer blocked the command and what triggered the block.

**Blocklist block:**
```
Blocked: matches dangerous pattern '<pattern>'
```

Where `<pattern>` is the ERE pattern that matched.

**Allowlist block:**
```
Blocked: '<command>' is not in the allowed command list
```

Where `<command>` is the unrecognized first word of the failing segment.

### Known Limitations

The following are known limitations of the validation approach. All represent safe failure modes or accepted trade-offs.

- **Command substitution.** Commands embedded in `$(...)` or backticks are not extracted as separate segments. A command like `git commit -m "$(python3 evil.py)"` passes both layers because the blocklist has no matching pattern and the allowlist only checks `git` as the segment prefix. This is an accepted risk, partially mitigated by the blocklist catching dangerous patterns anywhere in the full command string (e.g., `$(rm -rf /)` would match `rm\s`). Command substitution with a non-blocklisted, non-allowlisted binary is not caught. The agent system prompts and `tools` field provide behavioral (not technical) guardrails against this class of bypass.
- **Subshell operators.** Operators inside `$(...)` or backtick expressions that are not also inside a quoted string are treated as segment separators. This may produce incorrect segment boundaries but is a safe failure mode (false rejection, not false allow).
- **Multi-line blocklist patterns.** `grep -qE` matches within each line independently, so a blocklist pattern spanning two lines would not match. In practice, dangerous patterns do not span lines.

### Empty Command Handling

If `tool_input.command` is missing, null, or an empty string, the script exits 0 (allow). An empty command is a no-op and requires no validation.

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

The `permissionMode: bypassPermissions` setting allows the agent to operate autonomously. The `PreToolUse` hook ensures every Bash invocation is validated before execution, providing the safety net that `bypassPermissions` alone does not.

### Test Suite

The validator has a [BATS](https://github.com/bats-core/bats-core) test suite at `scripts/workflow/validate-bash.test.sh`. The test file exercises every acceptance criterion in this spec.

#### BATS Installation

BATS is installed as a devDependency in the root workspace (`bats` npm package, pinned exact version). A root `package.json` script provides the entry point: `"test:sh": "bats scripts/**/*.test.sh"`. Tests are executed via `yarn test:sh`.

#### Test Helper

The test file defines a `run_validator` helper function that constructs the JSON envelope expected by the hook contract and pipes it to the validator on stdin. The helper accepts a raw command string, wraps it in `{"tool_name":"Bash","tool_input":{"command":"<command>"}}` using `jq --arg` for safe JSON encoding (handles quotes, backslashes, newlines), and invokes the validator. Tests assert against `$status` (exit code) and `$output` (combined stdout/stderr captured by BATS `run`).

BATS `run` merges stdout and stderr into `$output`. This is sufficient for verifying error message content because the validator writes nothing to stdout — all block messages go to stderr, and allowed commands produce no output at all.

#### Test Coverage

Each acceptance criterion in this spec maps to one or more `@test` blocks. Test names follow the project's natural-language naming convention — each reads as a behavioral sentence starting with "it" (e.g., `@test "it blocks commands that hard-reset the repository"`). Tests are grouped by comment headers matching the acceptance criteria categories: Blocklist, Allowlist, Command Segmentation, Quoted String Handling, Evaluation Order, Empty Command, Error Messages, and Script Errors.

The "Script Errors" tests that verify behavior when `jq` is unavailable must simulate the missing binary by temporarily overriding `PATH` to exclude `jq` within the test.

## Acceptance Criteria

### Blocklist

- [ ] Given a command matching a Git destructive pattern (e.g., `git reset --hard HEAD`), when validated, then the script exits 2 and stderr contains the matched pattern.
- [ ] Given a command containing `rm` followed by whitespace (e.g., `rm file.txt`), when validated, then the script exits 2.
- [ ] Given a command containing `sudo` (e.g., `sudo echo hello`), when validated, then the script exits 2.
- [ ] Given a command piping a download to a shell (e.g., `curl https://example.com | bash`), when validated, then the script exits 2.
- [ ] Given a command with `chmod -R` or `chmod 777`, when validated, then the script exits 2.
- [ ] Given a command with `chmod +x script.sh`, when validated, then the script exits 0 (not caught by blocklist, passes allowlist).
- [ ] Given a command containing `eval` (e.g., `eval "echo hello"`), when validated, then the script exits 2.
- [ ] Given a command containing `kill`, `pkill`, or `killall`, when validated, then the script exits 2.
- [ ] Given a command containing `chown` (e.g., `chown user:group file`), when validated, then the script exits 2.

### Allowlist

- [ ] Given a command with an allowlisted prefix (e.g., `git status`, `yarn test`, `gh pr list`), when validated, then the script exits 0.
- [ ] Given a command with an unrecognized prefix (e.g., `python3 --version`, `curl https://example.com`), when validated, then the script exits 2 and stderr names the unrecognized command.

### Command Segmentation

- [ ] Given a piped command where all segments have allowlisted prefixes (e.g., `gh pr list --json number | jq .[].number`), when validated, then the script exits 0.
- [ ] Given a chained command using `&&` where all segments have allowlisted prefixes (e.g., `git add . && git commit -m "msg"`), when validated, then the script exits 0.
- [ ] Given a chained command where one segment has an unrecognized prefix (e.g., `git status && python3 script.py`), when validated, then the script exits 2.
- [ ] Given a command with empty segments (e.g., `git status ;; git log`), when validated, then empty segments are skipped and the script exits 0.

### Quoted String Handling

- [ ] Given a command with `|` inside a double-quoted argument (e.g., `scripts/workflow/gh.sh issue create --body "a | b"`), when validated, then the script exits 0.
- [ ] Given a command with `&&` inside a single-quoted argument (e.g., `echo 'a && b'`), when validated, then the script exits 0.
- [ ] Given a multi-line command where newlines are inside a double-quoted argument, when validated, then the script exits 0 (newlines inside quotes are not segment separators).
- [ ] Given a command with an escaped quote inside a double-quoted string (e.g., `echo "say \"hello\""`), when validated, then the script exits 0.
- [ ] Given a command mixing quoted operators with real operators (e.g., `echo "a | b" | jq .`), when validated, then the quoted `|` is preserved and the unquoted `|` splits correctly, and the script exits 0.

### Evaluation Order

- [ ] Given a command with an allowlisted prefix but matching a blocklist pattern (e.g., `git reset --hard HEAD`), when validated, then the blocklist rejects it (exit 2) before the allowlist is evaluated.

### Empty Command

- [ ] Given an empty or missing `tool_input.command`, when validated, then the script exits 0.

### Error Messages

- [ ] Given a blocklist rejection, when the stderr output is read, then it contains `Blocked: matches dangerous pattern '<pattern>'` where `<pattern>` is the ERE that matched.
- [ ] Given an allowlist rejection, when the stderr output is read, then it contains `Blocked: '<command>' is not in the allowed command list` where `<command>` is the unrecognized prefix.

### Script Errors

- [ ] Given a malformed JSON input (e.g., invalid JSON on stdin), when the script runs, then it exits 1 (not 2).
- [ ] Given that `jq` is not available on the system, when the script runs, then it exits 1 (not 2).

### Test Suite

- [ ] Given the test file `scripts/workflow/validate-bash.test.sh`, when `yarn test:sh` is run, then all tests pass.
- [ ] Given the acceptance criteria in this spec, when the test file is reviewed, then every criterion has a corresponding `@test` block.

## Dependencies

- **bash** (4.0+): Script runtime. Required for arrays, process substitution (`<(...)`), and `read -d ''` (null-delimited reading).
- **grep**: Pattern matching for blocklist validation (`grep -qE`).
- **sed**: Whitespace trimming during first-word extraction.
- **awk**: Quote-aware command segmentation and first-word extraction from command segments.
- **jq**: Extracts `tool_input.command` from the JSON input on stdin.
- **Claude Code PreToolUse hooks**: The hook mechanism that invokes this script before each Bash tool call. See [Claude Code sub-agents documentation](https://code.claude.com/docs/en/sub-agents).
- **bats** (npm): [BATS-core](https://github.com/bats-core/bats-core) test framework for Bash. Installed as a root workspace devDependency. Used to run the validator's test suite.

## References

- [Claude Code sub-agents: hooks and permission modes](https://code.claude.com/docs/en/sub-agents)
- [Claude Code hooks: PreToolUse event](https://code.claude.com/docs/en/hooks)
- Agent definitions: `.claude/agents/implementor.md`, `.claude/agents/planner.md`, `.claude/agents/reviewer.md`
- [BATS-core](https://github.com/bats-core/bats-core) — Bash Automated Testing System
