---
title: Label Setup Script
version: 0.1.1
last_updated: 2026-02-07
status: approved
---

# Label Setup Script

## Overview

One-time shell script that creates the required GitHub labels for the workflow system. The script ensures all labels defined by the development protocol exist in the repository with correct names, descriptions, and colors. It is idempotent and safe to run repeatedly.

## Constraints

- Must use the `gh` CLI for all GitHub API operations
- Must be a single Bash script at `scripts/workflow/setup-labels.sh`
- Must be idempotent: running multiple times produces the same result as running once
- Must not delete or modify labels that are not defined by this script
- Must not fail if a label already exists with the correct configuration
- Must authenticate using the token script defined in `docs/specs/workflow/github-cli-authentication.md`
- Must require no arguments

## Specification

### Usage

```bash
./scripts/workflow/setup-labels.sh
```

No arguments. The script operates on the repository determined by `gh`'s current repo context (i.e., the repo for the current working directory).

### Authentication

The script authenticates at startup by running `scripts/workflow/get-github-token.sh` and exporting the result as `GH_TOKEN`:

```bash
GH_TOKEN=$(./scripts/workflow/get-github-token.sh) || exit 1
export GH_TOKEN
```

If the token script fails (missing credentials, bad key, API error), it prints diagnostics to stderr and exits non-zero. The label setup script detects this and exits immediately with code `1`. No separate authentication check is performed.

### Label Definitions

#### Type Labels

| Label | Description | Color |
| --- | --- | --- |
| `task:implement` | Implementation work | `1d76db` |
| `task:refinement` | Spec clarification request | `5319e7` |
| `task:spec` | Spec writing or revision | `d4c5f9` |

#### Status Labels

| Label | Description | Color |
| --- | --- | --- |
| `status:pending` | Not yet started | `bfd4f2` |
| `status:in-progress` | Actively being worked | `0e8a16` |
| `status:blocked` | Waiting on non-spec blocker | `d93f0b` |
| `status:needs-refinement` | Blocked on spec issue | `fbca04` |
| `status:unblocked` | Previously blocked, ready to resume | `c2e0c6` |
| `status:review` | PR submitted, awaiting review | `006b75` |
| `status:needs-changes` | Review rejected | `e99695` |
| `status:approved` | Ready to merge | `2ea44f` |

#### Priority Labels

| Label | Description | Color |
| --- | --- | --- |
| `priority:high` | Do first | `b60205` |
| `priority:medium` | Default | `e4e669` |
| `priority:low` | Do when capacity allows | `c5def5` |

### Script Behavior

The script processes each label in the following order: type labels, status labels, priority labels.

For each label:

1. Check if the label already exists in the repository using `gh label list`.
2. If the label does not exist, create it using `gh label create` with the defined name, description, and color.
3. If the label already exists but has an incorrect description or color, update it using `gh label edit` to match the defined values.
4. If the label already exists with the correct configuration, skip it.

### Fetching Existing Labels

The script fetches the full list of existing labels once at startup using:

```bash
gh label list --limit 100 --json name,color,description
```

This assumes the repository has fewer than 100 total labels. This is a safe assumption for this project. The script does not need to handle pagination.

The returned JSON uses 6-character lowercase hex color values without a `#` prefix (e.g., `"1d76db"`). The script must compare colors in this format.

The script uses `jq` to parse the JSON output.

### Creating and Updating Labels

To create a new label:

```bash
gh label create "<name>" --description "<description>" --color "<hex without #>"
```

To update an existing label:

```bash
gh label edit "<name>" --description "<description>" --color "<hex without #>"
```

### Output Format

The script prints one line per label processed, indicating the action taken:

```
   created  task:implement
   created  task:refinement
   created  task:spec
up-to-date  status:pending
   updated  status:in-progress
   created  status:blocked
...
```

Each line has the format: `<action>  <label-name>` where `<action>` is left-padded with spaces to 10 characters (the length of `up-to-date`) so that label names align vertically. `<action>` is one of:

- `created` -- label did not exist and was created
- `updated` -- label existed but had incorrect description or color and was updated
- `up-to-date` -- label already existed with correct configuration, no action taken
- `failed` -- label create or update command returned an error. The `failed` status line is printed to stdout (keeping the per-line log consistent); the underlying error detail from `gh` is printed to stderr.

At the end of execution, the script prints a blank line followed by a summary line:

```
Done: 3 created, 1 updated, 9 up-to-date, 0 failed
```

The summary format is: `Done: <N> created, <N> updated, <N> up-to-date, <N> failed` where each `<N>` is the count for that action. The four counts must sum to the total number of defined labels (14).

### Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | All labels processed successfully |
| `1` | One or more labels failed to create or update (partial failure) |

### Error Handling

- If `gh` or `jq` is not installed, the script exits immediately with a descriptive error message and exit code `1`.
- If the token script (`scripts/workflow/get-github-token.sh`) fails, the script exits immediately with exit code `1`. The token script handles its own error messaging.
- If fetching the existing label list fails, the script exits immediately with a descriptive error message and exit code `1`.
- If a single label create/update fails, the script logs the error for that label (to stderr), continues processing remaining labels, and exits with code `1` after all labels are attempted.
- The script must not silently swallow errors.

### Idempotency

The script is idempotent. Running it multiple times:

- Does not create duplicate labels
- Corrects labels that have drifted from their defined configuration (wrong color or description)
- Reports `up-to-date` for labels that already match

## Acceptance Criteria

- [ ] Given the script file exists at `scripts/workflow/setup-labels.sh`, when inspected, then it is executable (`chmod +x`)
- [ ] Given a repository with no workflow labels, when the script is run, then all 14 labels (3 type + 8 status + 3 priority) are created with correct names, descriptions, and colors
- [ ] Given all workflow labels already exist with correct configuration, when the script is run, then output shows `up-to-date` for every label and exit code is `0`
- [ ] Given a label exists with an incorrect color, when the script is run, then the label is updated to the correct color and output shows `updated` for that label
- [ ] Given a label exists with an incorrect description, when the script is run, then the label is updated to the correct description and output shows `updated` for that label
- [ ] Given labels unrelated to the workflow exist in the repository, when the script is run, then those labels are not modified or deleted
- [ ] Given the script has run, when the summary line is printed, then it matches the format `Done: <N> created, <N> updated, <N> up-to-date, <N> failed` and the four counts sum to 14
- [ ] Given `gh` is not installed, when the script is run, then it exits with code `1` and prints an error message to stderr
- [ ] Given `jq` is not installed, when the script is run, then it exits with code `1` and prints an error message to stderr
- [ ] Given the token script fails (e.g., missing credentials), when the script is run, then it exits with code `1` before attempting any label operations
- [ ] Given a label fails to create, when the script continues, then remaining labels are still attempted and the final exit code is `1`

## Dependencies

- `gh` CLI
- `jq` (for parsing JSON output from `gh`)
- `scripts/workflow/get-github-token.sh` (see `docs/specs/workflow/github-cli-authentication.md`)
- Label definitions from the development protocol (`docs/workflow-v0.md`, "GitHub Labels" section)

## References

- Development protocol: `docs/workflow-v0.md` (GitHub Labels section)
- `gh label` CLI documentation: https://cli.github.com/manual/gh_label
