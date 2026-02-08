#!/usr/bin/env bash
#
# PreToolUse hook for workflow agent Bash commands.
#
# Two-layer validation:
#   1. Blocklist — reject commands matching dangerous patterns (checked first)
#   2. Allowlist — every command prefix in a chained/piped command must be recognized
#
# Exit 0 = allow
# Exit 2 = block (error message sent to agent via stderr)
#
# Input: JSON on stdin (from Claude Code PreToolUse hook)
#   { "tool_name": "Bash", "tool_input": { "command": "..." } }

set -euo pipefail

INPUT=$(cat)

# Extract command from JSON input. Trap jq failures so they exit 1 (script
# error), not whatever code jq returns — jq can exit 2 on usage errors, which
# would be misinterpreted as an intentional block.
if ! COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null); then
  echo "Script error: failed to parse JSON input" >&2
  exit 1
fi

if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# ─── Layer 1: Blocklist ─────────────────────────────────────────────────────
# Patterns checked against the FULL command string (before splitting).
# Any match is an immediate block, even if the command prefix is allowed.

blocklist=(
  # ── Git destructive operations ──
  # Note: force push is not blocked — branch protection rules handle that.
  'git\s+reset\s+--hard'
  'git\s+clean\s+-[a-zA-Z]*f'
  'git\s+checkout\s+\.'
  'git\s+restore\s+\.'
  'git\s+branch\s+.*-D\b'

  # ── File deletion ──
  'rm\s'

  # ── Privilege escalation ──
  '\bsudo\b'

  # ── Remote code execution ──
  'curl\s.*\|\s*(bash|sh|zsh)'
  'wget\s.*\|\s*(bash|sh|zsh)'
  '\beval\b'

  # ── System modification ──
  '\bdd\s+if='
  '\bmkfs\b'
  '\bfdisk\b'
  'chmod\s+-R'
  'chmod\s+777'
  'chmod\s+.*o\+w'
  'chmod\s+.*a\+w'
  '\bchown\b'

  # ── Process management ──
  '\bkill\b'
  '\bpkill\b'
  '\bkillall\b'
)

for pattern in "${blocklist[@]}"; do
  if echo "$COMMAND" | grep -qE "$pattern"; then
    echo "Blocked: matches dangerous pattern '$pattern'" >&2
    exit 2
  fi
done

# ─── Layer 2: Allowlist ─────────────────────────────────────────────────────
# Each segment of a chained/piped command must start with an allowed prefix.
# Segments are split on &&, ||, ;, and |.
#
# NOTE: This splitting is naive — it doesn't respect quoted strings. In
# practice, agent commands are simple chains (gh ... | jq ...) so this is
# adequate. A quoted string containing && would cause a false rejection,
# which is a safe failure mode (agent retries with different formatting).

allowlist=(
  # ── GitHub & Git ──
  gh
  git
  scripts/workflow/gh.sh
  ./scripts/workflow/gh.sh

  # ── Node.js ecosystem ──
  yarn

  # ── Text processing (commonly piped) ──
  cat
  head
  tail
  grep
  rg
  awk
  sed
  tr
  cut
  sort
  uniq
  wc
  jq
  xargs

  # ── Shell utilities ──
  echo
  printf
  ls
  pwd
  which
  command
  test
  true
  false
  env
  date
  basename
  dirname
  realpath

  # ── File operations (non-destructive) ──
  chmod
  mkdir
  touch
)

# Split on chain/pipe operators, validate each segment's first word
segments=$(echo "$COMMAND" | sed 's/&&/\n/g; s/||/\n/g; s/;/\n/g; s/|/\n/g')

while IFS= read -r segment; do
  # Trim leading whitespace, extract first word
  cmd=$(echo "$segment" | sed 's/^[[:space:]]*//' | awk '{print $1}')

  [[ -z "$cmd" ]] && continue

  allowed=false
  for prefix in "${allowlist[@]}"; do
    if [[ "$cmd" == "$prefix" ]]; then
      allowed=true
      break
    fi
  done

  if [[ "$allowed" != "true" ]]; then
    echo "Blocked: '$cmd' is not in the allowed command list" >&2
    exit 2
  fi
done <<< "$segments"

exit 0
