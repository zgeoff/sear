#!/usr/bin/env bash
#
# Authenticated gh CLI wrapper.
# Generates a GitHub App installation access token (with caching),
# exports it as GH_TOKEN, and forwards all arguments to `gh` via exec.
#
# Usage:
#   scripts/workflow/gh.sh issue view 1
#   scripts/workflow/gh.sh pr create --title "..." --body "..."
#
# Credentials are read from scripts/workflow/.env.local in the main repo root.
# In git worktrees, the main root is resolved automatically via git-common-dir.
# See scripts/workflow/.env.example for the required variables.
#
# Dependencies: gh, openssl, curl, jq

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve the main repo root so this script works from git worktrees.
# In a worktree, --git-common-dir returns the main repo's .git directory;
# in the main repo itself it returns ".git", which resolve handles correctly.
MAIN_ROOT="$(cd "$SCRIPT_DIR" && git rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="${MAIN_ROOT%/.git}"
MAIN_SCRIPT_DIR="$MAIN_ROOT/scripts/workflow"

# --- Check dependencies ---------------------------------------------------

for cmd in openssl curl jq gh; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required but not installed." >&2
    exit 1
  fi
done

# --- Token caching ---------------------------------------------------------

TOKEN_CACHE="$MAIN_SCRIPT_DIR/.token-cache"
TOKEN_EXPIRY="$MAIN_SCRIPT_DIR/.token-expiry"
CACHE_TTL=3300  # 55 minutes (5-minute buffer before 60-minute real expiry)

read_cached_token() {
  if [[ ! -f "$TOKEN_CACHE" ]] || [[ ! -f "$TOKEN_EXPIRY" ]]; then
    return 1
  fi

  local expiry
  expiry=$(<"$TOKEN_EXPIRY")
  local now
  now=$(date +%s)

  if (( now >= expiry )); then
    return 1
  fi

  local token
  token=$(<"$TOKEN_CACHE")
  if [[ -z "$token" ]]; then
    return 1
  fi

  echo "$token"
}

write_cached_token() {
  local token="$1"
  local now
  now=$(date +%s)
  echo "$token" > "$TOKEN_CACHE"
  echo $(( now + CACHE_TTL )) > "$TOKEN_EXPIRY"
}

# --- Try cache first -------------------------------------------------------

if CACHED=$(read_cached_token); then
  export GH_TOKEN="$CACHED"
  exec gh "$@"
fi

# --- Cache miss — generate a fresh token -----------------------------------

ENV_FILE="$MAIN_SCRIPT_DIR/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found. Copy .env.example to .env.local and populate it." >&2
  exit 1
fi

# Source the env file
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Validate required variables
for var in GH_APP_ID GH_APP_PRIVATE_KEY GH_APP_INSTALLATION_ID; do
  if [[ -z "${!var:-}" ]]; then
    echo "Error: $var is not set in $ENV_FILE" >&2
    exit 1
  fi
done

# Resolve the private key — either inline PEM content or a file path
if [[ "$GH_APP_PRIVATE_KEY" == "-----BEGIN"* ]]; then
  PRIVATE_KEY="$GH_APP_PRIVATE_KEY"
else
  # Resolve relative paths from the script's own directory
  if [[ "$GH_APP_PRIVATE_KEY" != /* ]]; then
    GH_APP_PRIVATE_KEY="$MAIN_SCRIPT_DIR/$GH_APP_PRIVATE_KEY"
  fi
  if [[ -f "$GH_APP_PRIVATE_KEY" ]]; then
    PRIVATE_KEY=$(<"$GH_APP_PRIVATE_KEY")
  else
    echo "Error: GH_APP_PRIVATE_KEY is not valid PEM content and file does not exist: $GH_APP_PRIVATE_KEY" >&2
    exit 1
  fi
fi

# Generate JWT
NOW=$(date +%s)
IAT=$((NOW - 60))
EXP=$((NOW + 600))

HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
PAYLOAD=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$IAT" "$EXP" "$GH_APP_ID" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')

SIGNATURE=$(printf '%s.%s' "$HEADER" "$PAYLOAD" \
  | openssl dgst -sha256 -sign <(echo "$PRIVATE_KEY") \
  | openssl base64 -e -A | tr '+/' '-_' | tr -d '=') || {
  echo "Error: JWT signing failed." >&2
  exit 1
}

JWT="${HEADER}.${PAYLOAD}.${SIGNATURE}"

# Exchange JWT for installation access token
RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/$GH_APP_INSTALLATION_ID/access_tokens")

TOKEN=$(echo "$RESPONSE" | jq -r '.token // empty')

if [[ -z "$TOKEN" ]]; then
  echo "Error: Failed to get installation token. Response:" >&2
  echo "$RESPONSE" | jq . >&2 2>/dev/null || echo "$RESPONSE" >&2
  exit 1
fi

# Cache the fresh token
write_cached_token "$TOKEN"

export GH_TOKEN="$TOKEN"
exec gh "$@"
