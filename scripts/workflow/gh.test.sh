#!/usr/bin/env bats
#
# BATS test suite for the gh.sh wrapper script.
# See: docs/specs/workflow/github-cli.md v0.2.0 (worktree support)

WRAPPER="scripts/workflow/gh.sh"

# Creates a temporary test repository with mocked env file and optional worktree.
# Sets up the following fixtures:
# - $MAIN_REPO: Path to the main repo root
# - $MAIN_SCRIPT_DIR: Path to scripts/workflow in main repo
# - $TEST_ENV_FILE: Path to .env.local in main repo
# - $WORKTREE_PATH: Path to the worktree (only if create_worktree=true)
setup_test_repo() {
  local create_worktree="${1:-false}"

  # Create main repo
  MAIN_REPO=$(mktemp -d)
  MAIN_SCRIPT_DIR="$MAIN_REPO/scripts/workflow"
  mkdir -p "$MAIN_SCRIPT_DIR"

  # Initialize git repo
  cd "$MAIN_REPO"
  git init -q
  git config user.email "test@example.com"
  git config user.name "Test User"

  # Copy the wrapper script
  cp "$OLDPWD/$WRAPPER" "$MAIN_SCRIPT_DIR/gh.sh"
  chmod +x "$MAIN_SCRIPT_DIR/gh.sh"

  # Create a mock .env.local with valid structure (paths resolved later)
  TEST_ENV_FILE="$MAIN_SCRIPT_DIR/.env.local"
  cat > "$TEST_ENV_FILE" <<'EOF'
GH_APP_ID=12345
GH_APP_PRIVATE_KEY=test-key.pem
GH_APP_INSTALLATION_ID=67890
EOF

  # Commit the wrapper (required for worktree creation)
  git add "$MAIN_SCRIPT_DIR/gh.sh"
  git commit -q -m "Add gh.sh wrapper"

  # Create worktree if requested
  if [[ "$create_worktree" == "true" ]]; then
    WORKTREE_PATH=$(mktemp -d)
    git worktree add -q "$WORKTREE_PATH"
  fi

  cd "$OLDPWD"
}

# Creates a mock PEM private key file for testing
create_mock_pem() {
  local path="$1"
  cat > "$path" <<'EOF'
-----BEGIN RSA PRIVATE KEY-----
MIIBogIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu
KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm
o3qGy0t6z09AIJtH+5OeRV1be+N4cDYJKffGzDa88vQENZiRm0GRq6a+HPGQMd2k
TQIhAKMSvzIBnni7ot/OSie2TmJLY4SwTQAevXysE2RbFDYdAiEBCUEaRQnMnbp7
9mxDXDf6AU0cN/RPBjb9qSHDcWZHGzUCIG2Es59z8ugGrDY+pxLQnwfotadxd+Uy
v/Ow5T0q5gIJAiEAyS4RaI9YG8EWx/2w0T67ZUVAw8eOMB6BIUg0Xcu+3okCIBOs
/5OiPgoTdSy7bcF9IGpSE8ZgGKzgYQVZeN97YE00
-----END RSA PRIVATE KEY-----
EOF
}

# Creates a mock gh binary that records its invocation and exits successfully.
# Expects to find GH_TOKEN in the environment.
create_mock_gh() {
  local gh_path="$1"
  local invocation_log="$2"

  cat > "$gh_path" <<'EOF'
#!/usr/bin/env bash
# Mock gh binary that records invocations
if [[ -z "$GH_TOKEN" ]]; then
  echo "Error: GH_TOKEN not set" >&2
  exit 1
fi
echo "$@" >> "$GH_INVOCATION_LOG"
echo "mock gh output"
exit 0
EOF
  chmod +x "$gh_path"
}

# Creates mock binaries for openssl, curl, and jq that simulate token generation.
# The mocks return a fixed token and avoid real API calls.
create_mock_dependencies() {
  local bin_dir="$1"

  # Mock openssl (used for JWT signing)
  cat > "$bin_dir/openssl" <<'EOF'
#!/usr/bin/env bash
# Mock openssl that returns predictable base64 output
if [[ "$1" == "base64" ]]; then
  echo "bW9ja2VkX2Jhc2U2NA"
elif [[ "$1" == "dgst" ]]; then
  echo "mockedSignature"
else
  cat
fi
EOF
  chmod +x "$bin_dir/openssl"

  # Mock curl (used for GitHub API)
  cat > "$bin_dir/curl" <<'EOF'
#!/usr/bin/env bash
# Mock curl that returns a valid token response
echo '{"token":"ghs_mockInstallationToken"}'
EOF
  chmod +x "$bin_dir/curl"

  # Mock jq (JSON parsing)
  cat > "$bin_dir/jq" <<'EOF'
#!/usr/bin/env bash
# Mock jq that extracts the token field
if [[ "$1" == "-r" && "$2" == ".token // empty" ]]; then
  echo "ghs_mockInstallationToken"
else
  cat
fi
EOF
  chmod +x "$bin_dir/jq"
}

teardown() {
  # Clean up temporary directories
  [[ -n "$MAIN_REPO" && -d "$MAIN_REPO" ]] && rm -rf "$MAIN_REPO"
  [[ -n "$WORKTREE_PATH" && -d "$WORKTREE_PATH" ]] && {
    cd "$MAIN_REPO" 2>/dev/null && git worktree remove -f "$WORKTREE_PATH" 2>/dev/null || true
    rm -rf "$WORKTREE_PATH"
  }
  [[ -n "$MOCK_BIN_DIR" && -d "$MOCK_BIN_DIR" ]] && rm -rf "$MOCK_BIN_DIR"
}

# ─── Worktree Path Resolution ─────────────────────────────────────────────────

@test "it resolves .env.local from the main repo's scripts/workflow/ directory when invoked from a worktree" {
  setup_test_repo true

  # Create mock dependencies
  MOCK_BIN_DIR=$(mktemp -d)
  create_mock_dependencies "$MOCK_BIN_DIR"
  create_mock_gh "$MOCK_BIN_DIR/gh" "$MAIN_REPO/gh-invocations.log"

  # Create the mock PEM key in the main repo
  create_mock_pem "$MAIN_SCRIPT_DIR/test-key.pem"

  # Run the wrapper from inside the worktree
  cd "$WORKTREE_PATH"
  export PATH="$MOCK_BIN_DIR:$PATH"
  export GH_INVOCATION_LOG="$MAIN_REPO/gh-invocations.log"

  run scripts/workflow/gh.sh issue list

  [[ "$status" -eq 0 ]]
  # Verify gh was invoked (which means .env.local was read successfully)
  [[ -f "$MAIN_REPO/gh-invocations.log" ]]
  grep -q "issue list" "$MAIN_REPO/gh-invocations.log"
}

@test "it reads and writes token cache files to the main repo's scripts/workflow/ directory when invoked from a worktree" {
  setup_test_repo true

  # Create mock dependencies
  MOCK_BIN_DIR=$(mktemp -d)
  create_mock_dependencies "$MOCK_BIN_DIR"
  create_mock_gh "$MOCK_BIN_DIR/gh" "$MAIN_REPO/gh-invocations.log"

  # Create the mock PEM key
  create_mock_pem "$MAIN_SCRIPT_DIR/test-key.pem"

  # Run the wrapper from inside the worktree
  cd "$WORKTREE_PATH"
  export PATH="$MOCK_BIN_DIR:$PATH"
  export GH_INVOCATION_LOG="$MAIN_REPO/gh-invocations.log"

  run scripts/workflow/gh.sh issue list

  [[ "$status" -eq 0 ]]
  # Verify cache files were written to the main repo, not the worktree
  [[ -f "$MAIN_SCRIPT_DIR/.token-cache" ]]
  [[ -f "$MAIN_SCRIPT_DIR/.token-expiry" ]]
  [[ ! -f "$WORKTREE_PATH/scripts/workflow/.token-cache" ]]
}

@test "it resolves a relative private key path from the main repo's scripts/workflow/ directory when invoked from a worktree" {
  setup_test_repo true

  # Create mock dependencies
  MOCK_BIN_DIR=$(mktemp -d)
  create_mock_dependencies "$MOCK_BIN_DIR"
  create_mock_gh "$MOCK_BIN_DIR/gh" "$MAIN_REPO/gh-invocations.log"

  # Create the mock PEM key with a relative path in the main repo
  create_mock_pem "$MAIN_SCRIPT_DIR/test-key.pem"

  # Update .env.local to use a relative path
  cat > "$TEST_ENV_FILE" <<'EOF'
GH_APP_ID=12345
GH_APP_PRIVATE_KEY=test-key.pem
GH_APP_INSTALLATION_ID=67890
EOF

  # Run the wrapper from inside the worktree
  cd "$WORKTREE_PATH"
  export PATH="$MOCK_BIN_DIR:$PATH"
  export GH_INVOCATION_LOG="$MAIN_REPO/gh-invocations.log"

  run scripts/workflow/gh.sh issue list

  [[ "$status" -eq 0 ]]
  # If the key wasn't found, the wrapper would have exited with code 1
}

# ─── Main Repo Path Resolution ───────────────────────────────────────────────

@test "it resolves all paths from scripts/workflow/ in the main repo when invoked from the main working tree root" {
  setup_test_repo false

  # Create mock dependencies
  MOCK_BIN_DIR=$(mktemp -d)
  create_mock_dependencies "$MOCK_BIN_DIR"
  create_mock_gh "$MOCK_BIN_DIR/gh" "$MAIN_REPO/gh-invocations.log"

  # Create the mock PEM key
  create_mock_pem "$MAIN_SCRIPT_DIR/test-key.pem"

  # Run the wrapper from the main repo root
  cd "$MAIN_REPO"
  export PATH="$MOCK_BIN_DIR:$PATH"
  export GH_INVOCATION_LOG="$MAIN_REPO/gh-invocations.log"

  run scripts/workflow/gh.sh issue list

  [[ "$status" -eq 0 ]]
  # Verify cache files were written to scripts/workflow/
  [[ -f "$MAIN_SCRIPT_DIR/.token-cache" ]]
  [[ -f "$MAIN_SCRIPT_DIR/.token-expiry" ]]
}

@test "it resolves all paths from scripts/workflow/ in the main repo when invoked from a subdirectory of the main working tree" {
  setup_test_repo false

  # Create a subdirectory in the main repo
  mkdir -p "$MAIN_REPO/some/nested/dir"

  # Create mock dependencies
  MOCK_BIN_DIR=$(mktemp -d)
  create_mock_dependencies "$MOCK_BIN_DIR"
  create_mock_gh "$MOCK_BIN_DIR/gh" "$MAIN_REPO/gh-invocations.log"

  # Create the mock PEM key
  create_mock_pem "$MAIN_SCRIPT_DIR/test-key.pem"

  # Run the wrapper from the subdirectory
  cd "$MAIN_REPO/some/nested/dir"
  export PATH="$MOCK_BIN_DIR:$PATH"
  export GH_INVOCATION_LOG="$MAIN_REPO/gh-invocations.log"

  # Use relative path to wrapper (simulating invocation from subdirectory)
  run ../../../scripts/workflow/gh.sh issue list

  [[ "$status" -eq 0 ]]
  # Verify cache files were written to scripts/workflow/ in the main repo
  [[ -f "$MAIN_SCRIPT_DIR/.token-cache" ]]
  [[ -f "$MAIN_SCRIPT_DIR/.token-expiry" ]]
}
