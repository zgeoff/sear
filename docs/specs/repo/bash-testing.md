---
title: Bash Testing
version: 0.1.0
last_updated: 2026-02-08
status: approved
---

# Bash Testing

## Overview

Shell scripts in this repository are tested using [BATS](https://github.com/bats-core/bats-core)
(Bash Automated Testing System). This spec defines how BATS is installed, how tests are discovered
and run, and how shell tests integrate into CI.

## Constraints

- Test files use the `.test.sh` extension and live alongside the scripts they test under `scripts/`.
- All shell tests run via `yarn test:sh`. Direct invocation of the `bats` binary is not supported.

## Specification

### BATS Installation

BATS is installed as a devDependency in the root workspace (`bats` npm package, pinned exact
version). The package is unplugged via `dependenciesMeta` because its executables are shell scripts
that cannot run from inside a Yarn PnP zip archive.

### Test Runner

The `bats` npm package does not declare a `bin` field, so `yarn bats` does not work. A wrapper
script at `scripts/run-bats.sh` resolves the binary through Yarn PnP
(`require.resolve('bats/bin/bats')`) and runs all `*.test.sh` files found under `scripts/`. The root
`package.json` exposes this as `"test:sh": "scripts/run-bats.sh"`.

If no `*.test.sh` files exist, `yarn test:sh` exits 0 with an informational message.

### Test Conventions

- Each `@test` name reads as a natural-language behavioral sentence starting with "it", consistent
  with the project's test naming convention.
- Tests are grouped within a file using comment headers (BATS has no native grouping construct).
- Test helpers (e.g., functions that construct stdin fixtures) are defined at the top of the test
  file, above the first `@test` block.

### CI Integration

Both CI workflows (`.github/workflows/pr.yml` and `.github/workflows/main.yml`) include a "Shell
tests" step that runs `yarn test:sh` after the existing "Test" step (which runs TypeScript/vitest
tests via Turborepo).

## Acceptance Criteria

- [ ] Given the `bats` npm package in root devDependencies, when `yarn test:sh` is run, then BATS
      discovers and executes all `*.test.sh` files under `scripts/`.
- [ ] Given no `*.test.sh` files exist under `scripts/`, when `yarn test:sh` is run, then it
      exits 0.
- [ ] Given the PR workflow (`.github/workflows/pr.yml`), when inspected, then it contains a "Shell
      tests" step that runs `yarn test:sh` after the "Test" step.
- [ ] Given the main workflow (`.github/workflows/main.yml`), when inspected, then it contains a
      "Shell tests" step that runs `yarn test:sh` after the "Test" step.

## Dependencies

- **bats** (npm): [BATS-core](https://github.com/bats-core/bats-core) test framework for Bash.
  Installed as a root workspace devDependency, unplugged for PnP compatibility.
- **bash** (4.0+): Required by both BATS and the wrapper script.

## References

- [BATS-core](https://github.com/bats-core/bats-core) — Bash Automated Testing System
- [Yarn PnP unplugged packages](https://yarnpkg.com/features/pnp#unplugged-packages)
