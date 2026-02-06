---
title: GitHub CLI Authentication
version: 0.1.0
last_updated: 2026-02-06
status: approved
---

# GitHub CLI Authentication

## Overview

Shell script that generates a short-lived GitHub App installation access token and prints it to stdout. The workflow system's agents and dispatcher use this token to authenticate `gh` CLI operations against the repository. The script reads GitHub App credentials from a local env file, constructs a JWT, and exchanges it for an installation access token via the GitHub API.

## Constraints

- Must be a single Bash script at `scripts/workflow/get-github-token.sh`
- Must read credentials from `scripts/workflow/.env.local` (not committed to version control)
- Must print only the token to stdout (all diagnostic output goes to stderr)
- Must not store or cache tokens -- a fresh token is generated on every invocation
- Must not require any CLI arguments
- Must exit with a non-zero code on any failure
- Must not depend on the `gh` CLI (this script is used to authenticate `gh`)

## Specification

### Usage

```bash
# Print token to stdout
./scripts/workflow/get-github-token.sh

# Use with gh CLI
export GH_TOKEN=$(./scripts/workflow/get-github-token.sh)
```

No arguments. The script reads all configuration from the env file. The script resolves all relative paths from its own directory, so it works regardless of the caller's working directory.

### Env File

The script reads credentials from `scripts/workflow/.env.local` (resolved relative to the script's own location). A template is provided at `scripts/workflow/.env.example`.

**Required variables:**

| Variable | Description |
|----------|-------------|
| `GH_APP_ID` | The GitHub App's numeric ID |
| `GH_APP_PRIVATE_KEY` | Path to the PEM private key file, or the PEM content itself |
| `GH_APP_INSTALLATION_ID` | The installation ID for the target repository or organization |

**Env example file** (`scripts/workflow/.env.example`):

```bash
# GitHub App credentials for workflow scripts
# Copy this file to .env.local and populate with your values.
GH_APP_ID=
GH_APP_PRIVATE_KEY=
GH_APP_INSTALLATION_ID=
```

The `.env.local` file must not be committed to version control. It must be listed in `.gitignore`.

### Private Key Resolution

The `GH_APP_PRIVATE_KEY` variable supports two formats:

1. **Inline PEM** -- If the value starts with `-----BEGIN`, it is treated as PEM key content directly.
2. **File path** -- Otherwise, the value is treated as a file path. If the file exists, its contents are read as the PEM key. If the file does not exist, the script prints an error naming the path to stderr and exits with code `1`.

### JWT Generation

The script constructs a JSON Web Token (JWT) signed with the App's private key:

1. Build the JWT header: `{"alg":"RS256","typ":"JWT"}`
2. Build the JWT payload with:
   - `iat` -- Issued at: current time minus 60 seconds (clock skew tolerance)
   - `exp` -- Expires at: current time plus 600 seconds (10 minutes, GitHub's maximum)
   - `iss` -- Issuer: the `GH_APP_ID`
3. Base64url-encode the header and payload.
4. Sign `{header}.{payload}` with the private key using RS256 (RSA + SHA-256).
5. Base64url-encode the signature.
6. Assemble the JWT as `{header}.{payload}.{signature}`.

All base64url encoding uses `openssl base64 -e -A` with `+/` replaced by `-_` and padding (`=`) stripped.

### Token Exchange

The script exchanges the JWT for an installation access token:

1. Send a `POST` request to `https://api.github.com/app/installations/{GH_APP_INSTALLATION_ID}/access_tokens` with:
   - Header: `Authorization: Bearer {JWT}`
   - Header: `Accept: application/vnd.github+json`
2. Parse the response JSON.
3. Extract the `token` field.
4. Print the token to stdout.

### Error Handling

The script validates prerequisites and reports failures to stderr:

| Condition | Behavior |
|-----------|----------|
| `scripts/workflow/.env.local` does not exist | Print error message to stderr, exit code `1` |
| A required variable (`GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_APP_INSTALLATION_ID`) is empty or unset | Print error naming the missing variable to stderr, exit code `1` |
| `GH_APP_PRIVATE_KEY` does not start with `-----BEGIN` and is not a path to an existing file | Print error naming the invalid path to stderr, exit code `1` |
| A required dependency (`openssl`, `curl`, `jq`) is not installed | Print error naming the missing dependency to stderr, exit code `1` |
| JWT signing fails (e.g., malformed PEM content, openssl error) | Print error with the openssl output to stderr, exit code `1` |
| The GitHub API returns an error or the response does not contain a `token` field | Print error with the API response to stderr, exit code `1` |

The script uses `set -euo pipefail` to fail fast on unexpected errors.

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Token generated successfully and printed to stdout |
| `1` | Any error (missing env file, missing variable, missing dependency, API failure) |

### Dependencies (Runtime)

The script requires these commands on `PATH`:

- `openssl` -- JWT signing and base64 encoding
- `curl` -- HTTP requests to the GitHub API
- `jq` -- JSON parsing of the API response

## Acceptance Criteria

- [ ] Given the script file exists at `scripts/workflow/get-github-token.sh`, when inspected, then it is executable (`chmod +x`)
- [ ] Given a valid `scripts/workflow/.env.local` with correct credentials, when the script is run, then a GitHub installation access token is printed to stdout and the exit code is `0`
- [ ] Given a valid `.env.local`, when the script is run, then no output other than the token appears on stdout (all diagnostics go to stderr)
- [ ] Given `scripts/workflow/.env.local` does not exist, when the script is run, then an error message referencing the missing file is printed to stderr and the exit code is `1`
- [ ] Given `.env.local` exists but `GH_APP_ID` is empty, when the script is run, then an error message naming `GH_APP_ID` is printed to stderr and the exit code is `1`
- [ ] Given `.env.local` exists but `GH_APP_PRIVATE_KEY` is empty, when the script is run, then an error message naming `GH_APP_PRIVATE_KEY` is printed to stderr and the exit code is `1`
- [ ] Given `.env.local` exists but `GH_APP_INSTALLATION_ID` is empty, when the script is run, then an error message naming `GH_APP_INSTALLATION_ID` is printed to stderr and the exit code is `1`
- [ ] Given `GH_APP_PRIVATE_KEY` is set to a valid file path containing a PEM key, when the script is run, then the key is read from that file and token generation succeeds
- [ ] Given `GH_APP_PRIVATE_KEY` is set to inline PEM content starting with `-----BEGIN`, when the script is run, then the inline content is used directly and token generation succeeds
- [ ] Given `GH_APP_PRIVATE_KEY` is set to a path that does not exist, when the script is run, then an error message naming the invalid path is printed to stderr and the exit code is `1`
- [ ] Given `GH_APP_PRIVATE_KEY` contains malformed PEM content, when the script is run, then an error is printed to stderr and the exit code is `1`
- [ ] Given `openssl` is not installed, when the script is run, then an error message naming `openssl` is printed to stderr and the exit code is `1`
- [ ] Given `curl` is not installed, when the script is run, then an error message naming `curl` is printed to stderr and the exit code is `1`
- [ ] Given `jq` is not installed, when the script is run, then an error message naming `jq` is printed to stderr and the exit code is `1`
- [ ] Given the GitHub API returns an error response, when the script is run, then the API response is printed to stderr and the exit code is `1`
- [ ] Given the GitHub API returns a 200 response without a `token` field, when the script is run, then the response is printed to stderr and the exit code is `1`
- [ ] Given `scripts/workflow/.env.example` exists, when inspected, then it contains the three required variable names (`GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_APP_INSTALLATION_ID`) with empty values and descriptive comments
- [ ] Given the script is invoked from a directory other than the repository root, when the script is run, then it resolves the env file relative to its own location and succeeds
- [ ] Given the repository's `.gitignore`, when inspected, then `scripts/workflow/.env.local` is excluded from version control

## Dependencies

- `openssl`, `curl`, `jq` (available on PATH)
- A registered GitHub App with: App ID, private key (.pem), and installation ID for the target repository
- `scripts/workflow/.env.local` populated with valid credentials

## References

- GitHub App authentication docs: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
- GitHub App installation token docs: https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
- Development protocol: `docs/workflow-v0.md`
