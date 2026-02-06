#!/usr/bin/env bash
#
# Generates a GitHub App installation access token and prints it to stdout.
# Reads credentials from .env.local in the script's own directory.
#
# Usage:
#   ./scripts/workflow/get-github-token.sh          # prints token
#   export GH_TOKEN=$(./scripts/workflow/get-github-token.sh)  # use with gh CLI
#
# Required .env.local variables:
#   GH_APP_ID              - GitHub App ID
#   GH_APP_PRIVATE_KEY     - Path to the PEM private key file, or the PEM content itself
#   GH_APP_INSTALLATION_ID - Installation ID for the target repo/org
#
# Dependencies: openssl, curl, jq

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENV_FILE="$SCRIPT_DIR/.env.local"

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

# Check dependencies
for cmd in openssl curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required but not installed." >&2
    exit 1
  fi
done

# Resolve the private key — either inline PEM content or a file path
if [[ "$GH_APP_PRIVATE_KEY" == "-----BEGIN"* ]]; then
  PRIVATE_KEY="$GH_APP_PRIVATE_KEY"
elif [[ -f "$GH_APP_PRIVATE_KEY" ]]; then
  PRIVATE_KEY=$(cat "$GH_APP_PRIVATE_KEY")
else
  echo "Error: GH_APP_PRIVATE_KEY is not valid PEM content and file does not exist: $GH_APP_PRIVATE_KEY" >&2
  exit 1
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

echo "$TOKEN"
