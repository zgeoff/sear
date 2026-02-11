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

# ─── Quote Masking ──────────────────────────────────────────────────────────
# Replaces the contents of single- and double-quoted strings with spaces,
# preserving quote delimiters and string length. Backslash escapes are
# respected outside quotes and inside double quotes; single-quoted strings
# are literal. Unclosed quotes mask to end of string.
mask_quotes() {
  printf '%s' "$1" | awk -v sq="'" '
  { buf = buf sep $0; sep = "\n" }
  END {
    len = length(buf)
    q = ""
    out = ""
    i = 1
    while (i <= len) {
      c = substr(buf, i, 1)
      if (q == "") {
        if (c == "\"" || c == sq) {
          q = c
          out = out c
          i++
          continue
        }
        if (c == "\\" && i < len) {
          out = out c substr(buf, i + 1, 1)
          i += 2
          continue
        }
        out = out c
      } else {
        if (c == "\\" && q == "\"" && i < len) {
          out = out "  "
          i += 2
          continue
        }
        if (c == q) {
          q = ""
          out = out c
        } else {
          out = out " "
        }
      }
      i++
    }
    printf "%s", out
  }'
}

MASKED_COMMAND=$(mask_quotes "$COMMAND")

# ─── Layer 1: Blocklist ─────────────────────────────────────────────────────
# Patterns checked against a quote-masked copy of the command string (before
# splitting). Any match is an immediate block, even if the command prefix is
# allowed.

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
  if echo "$MASKED_COMMAND" | grep -qE "$pattern"; then
    echo "Blocked: matches dangerous pattern '$pattern'" >&2
    exit 2
  fi
done

# ─── Layer 2: Allowlist ─────────────────────────────────────────────────────
# Each segment of a chained/piped command must start with an allowed prefix.
# Segments are split on &&, ||, ;, |, and newlines — but only outside quoted
# strings. Backslash escapes are respected outside quotes and inside double
# quotes (per bash quoting rules). Single-quoted strings are literal.

allowlist=(
  # ── Git ──
  git
  scripts/workflow/gh.sh
  ./scripts/workflow/gh.sh

  # ── Node.js ecosystem ──
  yarn

  # ── Text processing (commonly piped) ──
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
  diff
  tee

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
  find

  # ── File operations (non-destructive) ──
  chmod
  mkdir
  touch
  cp
  mv
)

# Splits a command string into null-delimited segments on &&, ||, ;, |, and
# newlines. Operators inside single- or double-quoted strings are preserved
# (not treated as separators). Backslash escapes are handled outside quotes
# and inside double quotes; single-quoted strings are literal.
split_segments() {
  printf '%s' "$1" | awk -v sq="'" '
  { buf = buf sep $0; sep = "\n" }
  END {
    len = length(buf)
    q = ""
    seg = ""
    i = 1
    while (i <= len) {
      c = substr(buf, i, 1)
      if (q == "") {
        if (c == "\"" || c == sq) {
          q = c
          seg = seg c
          i++
          continue
        }
        if (c == "\\" && i < len) {
          seg = seg c substr(buf, i + 1, 1)
          i += 2
          continue
        }
        if (i < len) {
          cc = substr(buf, i, 2)
          if (cc == "&&" || cc == "||") {
            printf "%s%c", seg, 0
            seg = ""
            i += 2
            continue
          }
        }
        if (c == "|" || c == ";" || c == "\n") {
          printf "%s%c", seg, 0
          seg = ""
          i++
          continue
        }
        seg = seg c
      } else {
        if (c == "\\" && q == "\"" && i < len) {
          seg = seg c substr(buf, i + 1, 1)
          i += 2
          continue
        }
        if (c == q) {
          q = ""
        }
        seg = seg c
      }
      i++
    }
    if (seg != "") printf "%s%c", seg, 0
  }'
}

# Validate each segment's first word against the allowlist
while IFS= read -r -d '' segment; do
  cmd=$(printf '%s' "$segment" | head -1 | sed 's/^[[:space:]]*//' | awk '{print $1}')

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
done < <(split_segments "$COMMAND")

exit 0
