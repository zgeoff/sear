---
title: Agent Hook — Bash Validator
version: 0.2.0
last_updated: 2026-02-11
status: approved
---

# Agent Hook — Bash Validator

## Overview

Workflow agents (Implementor, Planner, Reviewer) run with `permissionMode: bypassPermissions` to
operate autonomously. This removes all interactive permission prompts but also removes all
guardrails on the Bash tool — an agent could execute any shell command without restriction. The Bash
Validator is a `PreToolUse` hook that restores safety by validating every Bash command against a
two-layer filter (blocklist of dangerous patterns, allowlist of permitted command prefixes) before
execution.

This spec defines the validation rules. It does not prescribe an implementation language or runtime.
Implementations must produce identical accept/reject decisions for any given command string.

## Constraints

- The validator is a pure validation gate. It must not modify files, produce side effects, or
  execute the command itself.
- The validator must fail closed. False rejections (blocking a safe command) are acceptable; false
  allows (permitting a dangerous command) are not.
- Blocklist evaluation must always precede allowlist evaluation. This order is non-negotiable.
- A single shared rule set serves all workflow agents. Per-agent customization is not supported —
  agent-level differentiation is handled by the `tools` field in each agent's definition, not by the
  validator.

## Specification

### Evaluation Order

Validation runs in two layers, strictly in this order:

1. **Blocklist** — checked first. A blocklist match immediately rejects the command, regardless of
   whether the command prefix is allowlisted.
2. **Allowlist** — checked second. Every command segment must start with a recognized prefix.

This order is mandatory. Blocklist-first ensures that a dangerous command (e.g., `git reset --hard`)
is always rejected even though its prefix (`git`) is allowlisted.

### Layer 1: Blocklist

The blocklist is a set of regular expression patterns. Patterns use Extended Regular Expression
(ERE) syntax with GNU extensions (`\s` for whitespace, `\b` for word boundary). The shell
implementation matches via `grep -qE` (which supports these extensions on GNU/Linux); the TypeScript
implementation uses equivalent JavaScript `RegExp`. Each pattern is matched against a **quote-masked
copy** of the full command string (before segmentation). For multi-line command strings, the shell
implementation matches per-line (see Known Limitations). Matching is case-sensitive.

If any pattern matches, the command is blocked.

#### Quote Masking

Before blocklist evaluation, a masked copy of the command string is produced by replacing the
contents of quoted strings with spaces. Each character between the quote delimiters is replaced with
exactly one space, preserving the length of the original string. Opening and closing quote
characters are preserved; only the characters between them are replaced. This prevents blocklist
patterns from matching words that appear as string literals in arguments (e.g., `kill` in a commit
message, `eval` in an issue comment).

The masking rules follow the same quoting semantics used by command segmentation:

- **Double-quoted strings** (`"..."`): Characters between the opening `"` and closing `"` are
  replaced with spaces. Backslash escapes inside double quotes are respected — `\"` does not close
  the quoted context. The quote delimiters themselves are preserved.
- **Single-quoted strings** (`'...'`): Characters between the opening `'` and closing `'` are
  replaced with spaces. Backslashes have no special meaning inside single quotes. The quote
  delimiters themselves are preserved.
- **Unquoted content**: Left unchanged.
- **Backslash escapes outside quotes**: The backslash and the following character are preserved (not
  masked).
- **Unclosed quotes**: If a quote is opened but never closed, the masking treats all content from
  the opening quote to the end of the string as quoted (masked). This is a safe failure mode for the
  blocklist — more content is masked, which may cause false allows for dangerous patterns inside the
  unclosed quote. In practice, unclosed quotes produce bash syntax errors, so the command would fail
  at execution regardless.

| Command                            | Masked copy                         |
| ---------------------------------- | ----------------------------------- |
| `git commit -m "fix: kill timers"` | `git commit -m "                "`  |
| `echo 'eval this'`                 | `echo '         '`                  |
| `kill 1234`                        | `kill 1234` (no quotes — unchanged) |
| `echo "say \"hello\""`             | `echo "             "`              |
| `echo "a \| b" \| jq .`            | `echo "     " \| jq .`              |

The masked string is used **only** for blocklist evaluation. The original (unmasked) command string
is used for all subsequent validation (command segmentation and allowlist checks).

#### Blocklist Patterns

Force pushing is not blocked by this validator. Branch protection rules are the appropriate
mechanism for preventing force pushes to protected branches.

| Category              | Pattern                     | Blocks                      |
| --------------------- | --------------------------- | --------------------------- | ----- | ------------------------- |
| Git destructive       | `git\s+reset\s+--hard`      | Hard reset                  |
| Git destructive       | `git\s+clean\s+-[a-zA-Z]*f` | Clean with force            |
| Git destructive       | `git\s+checkout\s+\.`       | Discard all working changes |
| Git destructive       | `git\s+restore\s+\.`        | Discard all working changes |
| Git destructive       | `git\s+branch\s+.*-D\b`     | Force-delete branch         |
| File deletion         | `rm\s`                      | Any `rm` invocation         |
| Privilege escalation  | `\bsudo\b`                  | Any `sudo` usage            |
| Remote code execution | `curl\s._\|\s_(bash         | sh                          | zsh)` | Piping downloads to shell |
| Remote code execution | `wget\s._\|\s_(bash         | sh                          | zsh)` | Piping downloads to shell |
| Remote code execution | `\beval\b`                  | Eval execution              |
| System modification   | `\bdd\s+if=`                | Disk dump                   |
| System modification   | `\bmkfs\b`                  | Filesystem creation         |
| System modification   | `\bfdisk\b`                 | Partition management        |
| System modification   | `chmod\s+-R`                | Recursive permission change |
| System modification   | `chmod\s+777`               | World-writable permissions  |
| System modification   | `chmod\s+.*o\+w`            | Other-write permission      |
| System modification   | `chmod\s+.*a\+w`            | All-write permission        |
| System modification   | `\bchown\b`                 | Ownership change            |
| Process management    | `\bkill\b`                  | Kill process                |
| Process management    | `\bpkill\b`                 | Kill by name                |
| Process management    | `\bkillall\b`               | Kill all by name            |

### Layer 2: Allowlist

If the command passes the blocklist, every segment of the command is checked against the allowlist.
A segment's **first word** must exactly match an entry in the allowlist. If any segment's first word
is not recognized, the command is blocked.

The first word is extracted from the **first line** of the segment by trimming leading whitespace
and taking the first whitespace-delimited token. Only the first line is considered because segments
may contain embedded newlines from quoted strings spanning multiple lines. Empty segments (no
non-whitespace content) are skipped.

#### Command Segmentation

The command string is split into segments on these operators: `&&`, `||`, `;`, `|`, and newlines.

Splitting is quote-aware. Operators inside single-quoted (`'...'`) or double-quoted (`"..."`)
strings are not treated as segment separators. Backslash escapes are respected outside quotes and
inside double-quoted strings (e.g., `\"` does not close the quoted context). Single-quoted strings
are literal — backslashes have no special meaning inside them, consistent with bash quoting rules.

The parser walks the command string character by character, tracking whether it is inside a quoted
context. When a segment separator is encountered outside a quoted context, the current segment is
emitted and a new one begins. Two-character operators (`&&`, `||`) are checked before
single-character operators (`|`) to avoid incorrect splitting.

Subshell expressions (`$(...)`, backticks) are not parsed. An operator inside a subshell that is not
also inside a quoted string is incorrectly treated as a segment separator. This is a safe failure
mode (false rejection).

#### Allowlist Prefixes

| Category          | Prefixes                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Git               | `git`, `scripts/workflow/gh.sh`, `./scripts/workflow/gh.sh`                                                                          |
| Node.js ecosystem | `yarn`                                                                                                                               |
| Text processing   | `head`, `tail`, `grep`, `rg`, `awk`, `sed`, `tr`, `cut`, `sort`, `uniq`, `wc`, `jq`, `xargs`, `diff`, `tee`                          |
| Shell utilities   | `echo`, `printf`, `ls`, `pwd`, `which`, `command`, `test`, `true`, `false`, `env`, `date`, `basename`, `dirname`, `realpath`, `find` |
| File operations   | `chmod` (subject to blocklist restrictions), `mkdir`, `touch`, `cp`, `mv`                                                            |

### Empty Command Handling

If the command is missing, null, or an empty string, the validator allows it. An empty command is a
no-op and requires no validation.

### Error Message Format

When a command is blocked, the validator must produce a message identifying which layer blocked the
command and what triggered the block.

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

The following are known limitations of the validation approach. All represent safe failure modes or
accepted trade-offs.

- **Command substitution.** Commands embedded in `$(...)` or backticks are not extracted as separate
  segments. A command like `git commit -m "$(python3 evil.py)"` passes both layers because the
  blocklist sees only the masked (empty) quoted content and the allowlist only checks `git` as the
  segment prefix. This is an accepted risk, partially mitigated by the blocklist catching dangerous
  patterns in unquoted command substitutions (e.g., unquoted `$(rm -rf /)` would match `rm\s`
  because the subshell content is not inside a quoted string). Double-quoted command substitutions
  like `"$(rm -rf /)"` are not caught because quote masking replaces the quoted content — this is a
  deliberate trade-off to eliminate false positives on string arguments (see
  [Quote Masking](#quote-masking)). Command substitution with a non-blocklisted, non-allowlisted
  binary is not caught. The agent system prompts and `tools` field provide behavioral (not
  technical) guardrails against this class of bypass.
- **Subshell operators.** Operators inside `$(...)` or backtick expressions that are not also inside
  a quoted string are treated as segment separators. This may produce incorrect segment boundaries
  but is a safe failure mode (false rejection, not false allow).
- **Heredocs.** Heredoc content (`<<EOF...EOF`) is not inside single- or double-quoted strings, so
  it is not masked. Blocklist patterns will match inside heredoc bodies, which may cause false
  rejections for commands like `git commit -m "$(head <<EOF\nkill the process\nEOF\n)"`. This is a
  safe failure mode (false rejection, not false allow) and is consistent with the fail-closed
  constraint.
- **Multi-line blocklist patterns.** The shell implementation uses `grep -qE`, which matches
  per-line. A blocklist pattern spanning two lines would not match. The TypeScript implementation
  uses `RegExp.test()` against the full string, where `\s` matches `\n`, so it may catch multi-line
  patterns that the shell implementation misses. Both behaviors are considered correct — the shell
  script's per-line matching is a safe failure mode (false rejection is acceptable per the
  fail-closed constraint). The Implementation Equivalence criterion excludes multi-line test vectors
  to account for this divergence.

## Acceptance Criteria

### Blocklist

- [ ] Given a command matching a Git destructive pattern (e.g., `git reset --hard HEAD`), when
      validated, then the command is blocked and the error message contains the matched pattern.
- [ ] Given a command containing `rm` followed by whitespace (e.g., `rm file.txt`), when validated,
      then the command is blocked.
- [ ] Given a command containing `sudo` (e.g., `sudo echo hello`), when validated, then the command
      is blocked.
- [ ] Given a command piping a download to a shell (e.g., `curl https://example.com | bash`), when
      validated, then the command is blocked.
- [ ] Given a command with `chmod -R` or `chmod 777`, when validated, then the command is blocked.
- [ ] Given a command with `chmod +x script.sh`, when validated, then the command is allowed (not
      caught by blocklist, passes allowlist).
- [ ] Given a command containing `eval` (e.g., `eval "echo hello"`), when validated, then the
      command is blocked.
- [ ] Given a command containing `kill`, `pkill`, or `killall`, when validated, then the command is
      blocked.
- [ ] Given a command containing `chown` (e.g., `chown user:group file`), when validated, then the
      command is blocked.
- [ ] Given a command using `dd` with an input file (e.g., `dd if=/dev/zero of=/dev/sda`), when
      validated, then the command is blocked.
- [ ] Given a command using `mkfs` (e.g., `mkfs.ext4 /dev/sda1`), when validated, then the command
      is blocked.
- [ ] Given a command using `fdisk` (e.g., `fdisk /dev/sda`), when validated, then the command is
      blocked.
- [ ] Given a command with `chmod o+w` or `chmod a+w`, when validated, then the command is blocked.
- [ ] Given a command piping `wget` to a shell (e.g., `wget https://example.com | sh`), when
      validated, then the command is blocked.

### Blocklist — Quote Masking

- [ ] Given a command where a blocklist word appears inside a double-quoted argument (e.g.,
      `git commit -m "fix: kill orphaned timers"`), when validated, then the command is allowed
      because the blocklist word is masked.
- [ ] Given a command where a blocklist word appears inside a single-quoted argument (e.g.,
      `echo 'eval this'`), when validated, then the command is allowed because the blocklist word is
      masked.
- [ ] Given a command where a blocklist pattern appears inside a double-quoted argument (e.g.,
      `git commit -m "rm stale cache entries"`), when validated, then the command is allowed because
      the pattern match falls within masked content.
- [ ] Given a command where a blocklist word appears inside a quoted argument alongside real
      operators outside the quotes (e.g., `git commit -m "kill orphan timers" && git push`), when
      validated, then the command is allowed.
- [ ] Given a command where a blocklist word appears outside any quoted string (e.g., `kill 1234`),
      when validated, then the command is still blocked (masking only affects content inside
      quotes).

### Allowlist

- [ ] Given a command with an allowlisted prefix (e.g., `git status`, `yarn test`,
      `scripts/workflow/gh.sh pr list`), when validated, then the command is allowed.
- [ ] Given a command with an unrecognized prefix (e.g., `python3 --version`,
      `curl https://example.com`, `gh pr list`), when validated, then the command is blocked and the
      error message names the unrecognized command.

### Command Segmentation

- [ ] Given a piped command where all segments have allowlisted prefixes (e.g.,
      `scripts/workflow/gh.sh pr list --json number | jq .[].number`), when validated, then the
      command is allowed.
- [ ] Given a chained command using `&&` where all segments have allowlisted prefixes (e.g.,
      `git add . && git commit -m "msg"`), when validated, then the command is allowed.
- [ ] Given a chained command where one segment has an unrecognized prefix (e.g.,
      `git status && python3 script.py`), when validated, then the command is blocked.
- [ ] Given a command using `;` where all segments have allowlisted prefixes (e.g.,
      `git status ; echo done`), when validated, then the command is allowed.
- [ ] Given a command using `||` where all segments have allowlisted prefixes (e.g.,
      `git status || echo fallback`), when validated, then the command is allowed.
- [ ] Given a newline-separated command where all segments have allowlisted prefixes (e.g.,
      `git status\necho done`), when validated, then the command is allowed.
- [ ] Given a newline-separated command where one segment has an unrecognized prefix, when
      validated, then the command is blocked.
- [ ] Given a command with empty segments (e.g., `git status ;; git log`), when validated, then
      empty segments are skipped and the command is allowed.

### Quoted String Handling

- [ ] Given a command with `|` inside a double-quoted argument (e.g.,
      `scripts/workflow/gh.sh issue create --body "a | b"`), when validated, then the command is
      allowed.
- [ ] Given a command with `&&` inside a single-quoted argument (e.g., `echo 'a && b'`), when
      validated, then the command is allowed.
- [ ] Given a multi-line command where newlines are inside a double-quoted argument, when validated,
      then the command is allowed (newlines inside quotes are not segment separators).
- [ ] Given a command with an escaped quote inside a double-quoted string (e.g.,
      `echo "say \"hello\""`), when validated, then the command is allowed.
- [ ] Given a command mixing quoted operators with real operators (e.g., `echo "a | b" | jq .`),
      when validated, then the quoted `|` is preserved and the unquoted `|` splits correctly, and
      the command is allowed.

### Evaluation Order

- [ ] Given a command with an allowlisted prefix but matching a blocklist pattern (e.g.,
      `git reset --hard HEAD`), when validated, then the blocklist rejects it before the allowlist
      is evaluated.

### Empty Command

- [ ] Given an empty or missing command, when validated, then the command is allowed.

### Implementation Equivalence

- [ ] Given a shared set of test vectors (command strings with expected accept/reject outcomes),
      when executed against both the shell script and TypeScript implementations, then both produce
      identical decisions for every vector. Test vectors must use single-line commands only —
      multi-line commands are excluded because `\s` in GNU grep does not match `\n` while JavaScript
      `RegExp` `\s` does (see [Known Limitations](#known-limitations)).

## Dependencies

- **Claude Code PreToolUse hooks**: The hook mechanism that invokes validation before each Bash tool
  call. See [Claude Code hooks](https://code.claude.com/docs/en/hooks).

## References

- `agent-hook-bash-validator-script.md` — Shell script implementation (for interactive agent use)
- [control-plane-engine-agent-manager.md: Programmatic Hooks](./control-plane-engine-agent-manager.md#programmatic-hooks)
  — TypeScript implementation (for control plane agent sessions)
- Agent definitions: `.claude/agents/implementor.md`, `.claude/agents/planner.md`,
  `.claude/agents/reviewer.md`
