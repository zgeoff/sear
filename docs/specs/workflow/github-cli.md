---
title: GitHub CLI Wrapper
version: 0.3.0
last_updated: 2026-02-12
status: approved
---

# GitHub CLI Wrapper

## Overview

Authenticated wrapper script for the `gh` CLI. Workflow agents use this script as a drop-in
replacement for bare `gh` — it generates a short-lived GitHub App installation access token, caches
it to avoid redundant API calls, exports it as `GH_TOKEN`, and forwards all arguments to `gh` via
`exec`. The script reads GitHub App credentials from a local env file, constructs a JWT, and
exchanges it for an installation access token via the GitHub API.

## Constraints

- Must be a single Bash script at `scripts/workflow/gh.sh`
- Must forward all arguments to `gh` unchanged
- Must use `exec` to replace the shell process with `gh` (no subshell)
- Must read credentials from `scripts/workflow/.env.local` in the main repo root (not committed to
  version control)
- Must work identically when invoked from a git worktree — all auth and cache files resolve from the
  main repo root, not the worktree
- Must not require any CLI arguments beyond those intended for `gh`
- Must exit with a non-zero code if authentication fails, before reaching `gh`
- Must print all diagnostic output to stderr (stdout is reserved for `gh` output)
- Must cache tokens to avoid redundant API calls within a TTL window
- Must fall back to fresh token generation if the cache is missing, expired, or invalid

## Specification

### Usage

```bash
scripts/workflow/gh.sh <gh-args...>
```

The script is a transparent proxy for `gh`. Any valid `gh` command works:

```bash
scripts/workflow/gh.sh issue view 1
scripts/workflow/gh.sh pr create --title "feat: add X" --body "Closes #42"
scripts/workflow/gh.sh issue list --label "status:pending" --state open --json number,title
```

The script resolves all auth-related paths (env file, cache files, private key) from the **main repo
root**, not from its own directory. The main root is discovered via
`git rev-parse --path-format=absolute --git-common-dir`, which returns the main repo's `.git`
directory regardless of whether the script is invoked from the main working tree or a worktree.

> **Rationale:** This is critical for git worktree support — worktrees share the committed source
> tree but do not have gitignored files like `.env.local`.

### Execution Flow

On every invocation:

1. Resolve `SCRIPT_DIR` from the script's own location.
2. Resolve `MAIN_ROOT` — the main repo root — by stripping `/.git` from the output of
   `git rev-parse --path-format=absolute --git-common-dir` (run from `SCRIPT_DIR`). Derive
   `MAIN_SCRIPT_DIR` as `$MAIN_ROOT/scripts/workflow`.
3. Check the token cache (see [Token Caching](#token-caching)).
   - If a valid cached token exists, use it.
   - Otherwise, generate a fresh token (see [Token Generation](#token-generation)) and write it to
     the cache.
4. Export `GH_TOKEN` with the token value.
5. `exec gh "$@"` — replace the process with `gh`, forwarding all arguments.

If any step before `exec` fails, the script prints a diagnostic message to stderr and exits with
code `1`. The `gh` process is never started.

### Token Caching

The script caches the most recent token to avoid redundant JWT signing and API calls.

> **Rationale:** During burst operations (e.g., a planner cycle issuing 10-20 `gh` commands in quick
> succession), regenerating a token on every invocation would cause redundant API calls and latency.

**Cache files** (resolved relative to `MAIN_SCRIPT_DIR`, i.e. the main repo's `scripts/workflow/`):

| File                             | Contents                                                                    |
| -------------------------------- | --------------------------------------------------------------------------- |
| `scripts/workflow/.token-cache`  | The installation access token (plaintext)                                   |
| `scripts/workflow/.token-expiry` | Unix timestamp (seconds) when the cached token should be considered expired |

Both files must be listed in `.gitignore`.

**Cache read logic:**

1. If `.token-cache` does not exist or `.token-expiry` does not exist → cache miss.
2. Read the expiry timestamp from `.token-expiry`.
3. If the current time is greater than or equal to the expiry timestamp → cache miss.
4. Read the token from `.token-cache`.
5. If the token is empty → cache miss.
6. Otherwise → cache hit; use the cached token.

**Cache write logic:**

After a successful token generation, write the token to `.token-cache` and set `.token-expiry` to
the current time plus 3300 seconds (55 minutes).

> **Rationale:** GitHub installation access tokens are valid for 60 minutes; the 5-minute buffer
> ensures the cached token is never used close to its real expiry.

**Cache invalidation:**

The cache is passively invalidated by TTL. There is no active invalidation mechanism. If the cache
files are deleted or corrupted, the script falls through to fresh generation on the next invocation.

### Token Generation

When the cache is missed, the script generates a fresh GitHub App installation access token in-line.

#### Env File

The script reads credentials from `scripts/workflow/.env.local` in the main repo root (resolved via
`MAIN_SCRIPT_DIR`). A template is provided at `scripts/workflow/.env.example`.

**Required variables:**

| Variable                 | Description                                                   |
| ------------------------ | ------------------------------------------------------------- |
| `GH_APP_ID`              | The GitHub App's numeric ID                                   |
| `GH_APP_PRIVATE_KEY`     | Path to the PEM private key file, or the PEM content itself   |
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

#### Private Key Resolution

The `GH_APP_PRIVATE_KEY` variable supports two formats:

1. **Inline PEM** -- If the value starts with `-----BEGIN`, it is treated as PEM key content
   directly.
2. **File path** -- Otherwise, the value is treated as a file path. Relative paths are resolved from
   the main repo's `scripts/workflow/` directory (`MAIN_SCRIPT_DIR`). If the file exists, its
   contents are read as the PEM key. If the file does not exist, the script prints an error naming
   the path to stderr and exits with code `1`.

#### JWT Generation

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

All base64url encoding uses `openssl base64 -e -A` with `+/` replaced by `-_` and padding (`=`)
stripped.

#### Token Exchange

The script exchanges the JWT for an installation access token:

1. Send a `POST` request to
   `https://api.github.com/app/installations/{GH_APP_INSTALLATION_ID}/access_tokens` with:
   - Header: `Authorization: Bearer {JWT}`
   - Header: `Accept: application/vnd.github+json`
2. Parse the response JSON.
3. Extract the `token` field.
4. Return the token to the caller (execution flow step 2).

### Error Handling

The script validates prerequisites and reports failures to stderr:

| Condition                                                                                           | Behavior                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `scripts/workflow/.env.local` does not exist in the main repo root                                  | Print error message to stderr, exit code `1`                       |
| A required variable (`GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_APP_INSTALLATION_ID`) is empty or unset | Print error naming the missing variable to stderr, exit code `1`   |
| `GH_APP_PRIVATE_KEY` does not start with `-----BEGIN` and is not a path to an existing file         | Print error naming the invalid path to stderr, exit code `1`       |
| A required dependency (`openssl`, `curl`, `jq`, `gh`) is not installed                              | Print error naming the missing dependency to stderr, exit code `1` |
| JWT signing fails (e.g., malformed PEM content, openssl error)                                      | Print error with the openssl output to stderr, exit code `1`       |
| The GitHub API returns an error or the response does not contain a `token` field                    | Print error with the API response to stderr, exit code `1`         |

The script uses `set -euo pipefail` to fail fast on unexpected errors.

All errors halt execution before `gh` is started. A non-zero exit from the script always means `gh`
was never invoked.

### Exit Codes

| Code  | Meaning                                                                |
| ----- | ---------------------------------------------------------------------- |
| `0`   | `gh` executed successfully (exit code is from `gh` itself, via `exec`) |
| `1`   | Authentication or setup failure (before `gh` was started)              |
| Other | Propagated from `gh` via `exec`                                        |

### Runtime Prerequisites

The script requires these commands on `PATH`:

- `git` -- Main repo root discovery via `--git-common-dir` (worktree support)
- `gh` -- GitHub CLI (the command being wrapped)
- `openssl` -- JWT signing and base64 encoding
- `curl` -- HTTP requests to the GitHub API
- `jq` -- JSON parsing of the API response

## Acceptance Criteria

### Wrapper

- [ ] Given the script file exists at `scripts/workflow/gh.sh`, when inspected, then it is
      executable (`chmod +x`)
- [ ] Given valid credentials and a working `gh` installation, when
      `scripts/workflow/gh.sh issue list` is run, then the output matches what `gh issue list` would
      produce with the same token
- [ ] Given valid credentials, when `scripts/workflow/gh.sh issue view 1` is run, then `gh` receives
      `issue view 1` as its arguments (all arguments forwarded unchanged)
- [ ] Given valid credentials, when the script is run, then `gh` replaces the wrapper process via
      `exec` (no subshell; the wrapper's PID becomes the `gh` PID)
- [ ] Given the script is invoked from a directory other than the repository root, when the script
      is run, then it resolves auth paths from the main repo root and succeeds
- [ ] Given the script is invoked from inside a git worktree, when the script is run, then it reads
      `.env.local`, cache files, and private key paths from the main repo's `scripts/workflow/`
      directory (not the worktree's copy)

### Token Caching

- [ ] Given no `.token-cache` file exists, when the script is run, then a fresh token is generated
      via the GitHub API and written to `.token-cache`
- [ ] Given a valid `.token-cache` exists and `.token-expiry` is in the future, when the script is
      run, then the cached token is used and no GitHub API call is made for token generation
- [ ] Given `.token-expiry` is in the past, when the script is run, then a fresh token is generated
      and the cache files are overwritten
- [ ] Given `.token-cache` exists but is empty, when the script is run, then a fresh token is
      generated
- [ ] Given `.token-expiry` does not exist but `.token-cache` does, when the script is run, then a
      fresh token is generated
- [ ] Given a fresh token is generated, when the cache is written, then `.token-expiry` contains a
      timestamp 3300 seconds (55 minutes) in the future
- [ ] Given the repository's `.gitignore`, when inspected, then `scripts/workflow/.token-cache` and
      `scripts/workflow/.token-expiry` are excluded from version control

### Token Generation

- [ ] Given a valid `scripts/workflow/.env.local` with correct credentials, when a cache miss
      occurs, then a GitHub installation access token is generated and the exit code from `gh` is
      `0`
- [ ] Given a valid `.env.local`, when the script is run, then no diagnostic output appears on
      stdout (all diagnostics go to stderr; stdout is exclusively `gh` output)
- [ ] Given `scripts/workflow/.env.local` does not exist, when the script is run, then an error
      message referencing the missing file is printed to stderr and the exit code is `1`
- [ ] Given `.env.local` exists but `GH_APP_ID` is empty, when the script is run, then an error
      message naming `GH_APP_ID` is printed to stderr and the exit code is `1`
- [ ] Given `.env.local` exists but `GH_APP_PRIVATE_KEY` is empty, when the script is run, then an
      error message naming `GH_APP_PRIVATE_KEY` is printed to stderr and the exit code is `1`
- [ ] Given `.env.local` exists but `GH_APP_INSTALLATION_ID` is empty, when the script is run, then
      an error message naming `GH_APP_INSTALLATION_ID` is printed to stderr and the exit code is `1`
- [ ] Given `GH_APP_PRIVATE_KEY` is set to a valid file path containing a PEM key, when the script
      is run, then the key is read from that file and token generation succeeds
- [ ] Given `GH_APP_PRIVATE_KEY` is set to inline PEM content starting with `-----BEGIN`, when the
      script is run, then the inline content is used directly and token generation succeeds
- [ ] Given `GH_APP_PRIVATE_KEY` is set to a path that does not exist, when the script is run, then
      an error message naming the invalid path is printed to stderr and the exit code is `1`
- [ ] Given `GH_APP_PRIVATE_KEY` contains malformed PEM content, when the script is run, then an
      error is printed to stderr and the exit code is `1`
- [ ] Given `openssl` is not installed, when the script is run, then an error message naming
      `openssl` is printed to stderr and the exit code is `1`
- [ ] Given `curl` is not installed, when the script is run, then an error message naming `curl` is
      printed to stderr and the exit code is `1`
- [ ] Given `jq` is not installed, when the script is run, then an error message naming `jq` is
      printed to stderr and the exit code is `1`
- [ ] Given `gh` is not installed, when the script is run, then an error message naming `gh` is
      printed to stderr and the exit code is `1`
- [ ] Given the GitHub API returns an error response, when the script is run, then the API response
      is printed to stderr and the exit code is `1`
- [ ] Given the GitHub API returns a 200 response without a `token` field, when the script is run,
      then the response is printed to stderr and the exit code is `1`
- [ ] Given `scripts/workflow/.env.example` exists, when inspected, then it contains the three
      required variable names (`GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_APP_INSTALLATION_ID`) with
      empty values and descriptive comments
- [ ] Given the repository's `.gitignore`, when inspected, then `scripts/workflow/.env.local` is
      excluded from version control

## Dependencies

- `git`, `gh`, `openssl`, `curl`, `jq` (available on PATH)
- A registered GitHub App with: App ID, private key (.pem), and installation ID for the target
  repository
- `scripts/workflow/.env.local` populated with valid credentials

## References

- [GitHub App authentication docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
- [GitHub App installation token docs](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [GitHub CLI Workflow skill](../../../.claude/skills/github-workflow/SKILL.md)
- [Development protocol](./workflow.md)
