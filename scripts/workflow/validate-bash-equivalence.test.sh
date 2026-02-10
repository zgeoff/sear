#!/usr/bin/env bats
#
# BATS equivalence test: runs each shared test vector through the shell script
# validator and asserts the exit code matches the expected outcome.
#
# See: docs/specs/workflow/artifacts/bash-validator-test-vectors.json (canonical location)
# A symlink at scripts/workflow/bash-validator-test-vectors.json points to the canonical file.
# See: scripts/workflow/validate-bash.sh (shell implementation)

VALIDATOR="scripts/workflow/validate-bash.sh"
VECTORS="scripts/workflow/bash-validator-test-vectors.json"

# Constructs the JSON envelope expected by the hook contract and pipes it to
# the validator. Uses jq --arg for safe encoding of quotes, backslashes, and
# special characters in the command string.
run_validator() {
  local json
  json=$(jq -n --arg cmd "$1" '{"tool_name":"Bash","tool_input":{"command":$cmd}}')
  run bash -c 'printf "%s" "$1" | bash "$2"' _ "$json" "$VALIDATOR"
}

# Reads the vector count from the shared JSON file.
vector_count() {
  jq 'length' "$VECTORS"
}

# Reads a single vector field by index.
vector_field() {
  jq -r ".[$1].$2" "$VECTORS"
}

@test "shared test vectors file exists and is valid JSON" {
  [[ -f "$VECTORS" ]]
  jq empty "$VECTORS"
}

@test "shared test vectors file is not empty" {
  local count
  count=$(vector_count)
  [[ "$count" -gt 0 ]]
}

@test "all shared test vectors produce expected outcomes" {
  local count
  count=$(vector_count)
  local failures=0
  local failure_details=""

  for ((i = 0; i < count; i++)); do
    local cmd desc expected
    cmd=$(vector_field "$i" "command")
    desc=$(vector_field "$i" "description")
    expected=$(vector_field "$i" "expected")

    local expected_exit
    if [[ "$expected" == "allow" ]]; then
      expected_exit=0
    else
      expected_exit=2
    fi

    # Build JSON envelope and run validator
    local json
    json=$(jq -n --arg cmd "$cmd" '{"tool_name":"Bash","tool_input":{"command":$cmd}}')
    run bash -c 'printf "%s" "$1" | bash "$2"' _ "$json" "$VALIDATOR"

    if [[ "$status" -ne "$expected_exit" ]]; then
      failures=$((failures + 1))
      failure_details="${failure_details}
  FAIL vector[$i]: ${desc}
    command:  ${cmd}
    expected: exit ${expected_exit} (${expected})
    actual:   exit ${status}"
    fi
  done

  if [[ "$failures" -gt 0 ]]; then
    echo "${failures} vector(s) failed:${failure_details}" >&2
    return 1
  fi
}
