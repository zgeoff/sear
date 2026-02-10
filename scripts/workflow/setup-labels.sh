#!/usr/bin/env bash
#
# Creates or updates GitHub labels required by the workflow system.
# Idempotent: safe to run repeatedly.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
if ! command -v jq &>/dev/null; then
  echo "Error: jq is not installed." >&2
  exit 1
fi

# Use the authenticated gh wrapper (handles token generation and caching)
GH="${SCRIPT_DIR}/gh.sh"

# ---------------------------------------------------------------------------
# Fetch existing labels
# ---------------------------------------------------------------------------
existing_labels=$("$GH" label list --limit 100 --json name,color,description) || {
  echo "Error: failed to fetch existing labels." >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Label definitions: name|description|color
# ---------------------------------------------------------------------------
labels=(
  # Type labels
  "task:implement|Implementation work|1d76db"
  "task:refinement|Spec clarification request|5319e7"
  # Status labels
  "status:pending|Not yet started|bfd4f2"
  "status:in-progress|Actively being worked|0e8a16"
  "status:blocked|Waiting on non-spec blocker|d93f0b"
  "status:needs-refinement|Blocked on spec issue|fbca04"
  "status:unblocked|Previously blocked, ready to resume|c2e0c6"
  "status:review|PR submitted, awaiting review|006b75"
  "status:needs-changes|Review rejected|e99695"
  "status:approved|Ready to merge|2ea44f"
  # Priority labels
  "priority:high|Do first|b60205"
  "priority:medium|Default|e4e669"
  "priority:low|Do when capacity allows|c5def5"
  # Complexity labels
  "complexity:simple|Straightforward task — single-file, mechanical|d4c5f9"
  "complexity:complex|Multi-file or architecturally nuanced task|7057ff"
)

# ---------------------------------------------------------------------------
# Counters
# ---------------------------------------------------------------------------
count_created=0
count_updated=0
count_uptodate=0
count_failed=0
had_failure=0

# ---------------------------------------------------------------------------
# Process each label
# ---------------------------------------------------------------------------
for entry in "${labels[@]}"; do
  IFS='|' read -r name description color <<< "$entry"

  # Look up label in the cached list
  match=$(echo "$existing_labels" | jq -r --arg n "$name" '.[] | select(.name == $n)')

  if [[ -z "$match" ]]; then
    # Label does not exist — create it
    if "$GH" label create "$name" --description "$description" --color "$color" >/dev/null; then
      printf "%10s  %s\n" "created" "$name"
      (( ++count_created ))
    else
      printf "%10s  %s\n" "failed" "$name"
      (( ++count_failed ))
      had_failure=1
    fi
  else
    # Label exists — check if it needs updating
    existing_color=$(echo "$match" | jq -r '.color')
    existing_desc=$(echo "$match" | jq -r '.description')

    if [[ "$existing_color" == "$color" && "$existing_desc" == "$description" ]]; then
      printf "%10s  %s\n" "up-to-date" "$name"
      (( ++count_uptodate ))
    else
      if "$GH" label edit "$name" --description "$description" --color "$color" >/dev/null; then
        printf "%10s  %s\n" "updated" "$name"
        (( ++count_updated ))
      else
        printf "%10s  %s\n" "failed" "$name"
        (( ++count_failed ))
        had_failure=1
      fi
    fi
  fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Done: ${count_created} created, ${count_updated} updated, ${count_uptodate} up-to-date, ${count_failed} failed"

exit "$had_failure"
