---
title: Agent Bash Tool Validator
version: 0.1.0
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

The first word is extracted by trimming leading whitespace from the segment and taking the first whitespace-delimited token (equivalent to `echo "$segment" | sed 's/^[[:space:]]*//' | awk '{print $1}'`). Empty segments (no non-whitespace content) are skipped.

#### Command Segmentation

The command string is split into segments on these operators: `&&`, `||`, `;`, `|`.

Splitting is performed by literal string replacement (each operator replaced with a newline). This is a naive split — it does **not** respect quoted strings or subshell expressions. A quoted string containing `&&` (e.g., `echo "a && b"`) would be incorrectly split, resulting in a false rejection. This is a **known limitation** and a safe failure mode: the agent retries with different formatting.

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

- **Naive command segmentation.** Splitting on `&&`, `||`, `;`, `|` does not respect quoted strings or subshell expressions. A quoted string containing an operator (e.g., `echo "a && b"`) is incorrectly split, resulting in a false rejection. The agent retries with different formatting.
- **Command substitution.** Commands embedded in `$(...)` or backticks are not extracted as separate segments. A command like `git commit -m "$(python3 evil.py)"` passes both layers because the blocklist has no matching pattern and the allowlist only checks `git` as the segment prefix. This is an accepted risk, partially mitigated by the blocklist catching dangerous patterns anywhere in the full command string (e.g., `$(rm -rf /)` would match `rm\s`). Command substitution with a non-blocklisted, non-allowlisted binary is not caught. The agent system prompts and `tools` field provide behavioral (not technical) guardrails against this class of bypass.
- **Multi-line commands.** Commands with embedded newlines are not explicitly handled. `grep -qE` matches within each line independently, so a blocklist pattern spanning two lines would not match. In practice, Claude Code Bash tool calls are single-line commands.

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

## Dependencies

- **bash** (4.0+): Script runtime. Required for arrays and `<<<` here-strings.
- **grep**: Pattern matching for blocklist validation (`grep -qE`).
- **sed**: Command segmentation (operator splitting) and whitespace trimming.
- **awk**: First-word extraction from command segments.
- **jq**: Extracts `tool_input.command` from the JSON input on stdin.
- **Claude Code PreToolUse hooks**: The hook mechanism that invokes this script before each Bash tool call. See [Claude Code sub-agents documentation](https://code.claude.com/docs/en/sub-agents).

## References

- [Claude Code sub-agents: hooks and permission modes](https://code.claude.com/docs/en/sub-agents)
- [Claude Code hooks: PreToolUse event](https://code.claude.com/docs/en/hooks)
- Agent definitions: `.claude/agents/implementor.md`, `.claude/agents/planner.md`, `.claude/agents/reviewer.md`
