# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**sear** - A TypeScript/Rust monorepo using Yarn Berry workspaces.

## Build Commands

```bash
yarn build          # Build all packages/apps
yarn test           # Run tests across all packages
yarn lint           # Lint all packages
yarn format         # Format code with Biome
yarn format:check   # Check formatting without writing
yarn check          # Run lint, typecheck, and test (CI command)
yarn typecheck      # TypeScript type checking
```

### Single Package Commands

```bash
yarn workspace <package-name> <command>
# Example: yarn workspace @sear/core build
```

### Turborepo Commands

```bash
yarn turbo run build --filter=<package-name>  # Build single package with deps
yarn turbo run build --filter=...<package>    # Build package and dependents
```

## Architecture

### Directory Structure

- `packages/` - Shared libraries and utilities
- `apps/` - Applications (web, CLI, etc.)

### Workspace References

Packages can reference each other using workspace protocol:
```json
{
  "dependencies": {
    "@sear/core": "workspace:*"
  }
}
```

### Package Configuration

Each package should have:
- `package.json` with `name`, `main`, `types`, and scripts
- `tsconfig.json` extending root config: `"extends": "../../tsconfig.json"`
- `vitest.config.ts` if tests are needed

## Testing

### Vitest

```bash
yarn test                           # Run all tests
yarn workspace <pkg> test           # Run tests for single package
yarn workspace <pkg> test --watch   # Watch mode
```

### MSW (Mock Service Worker)

MSW is available for HTTP mocking in tests. Set up handlers per-package as needed.

## Tooling

### Yarn PnP + Zero Installs

This repo uses Yarn Plug'n'Play (PnP) with Zero Installs enabled:

- No `node_modules` folder
- Dependencies are stored in `.yarn/cache` and committed to git
- `.pnp.cjs` is committed, so cloning the repo is enough to run code (no `yarn install` needed)
- IDE integration: Run `yarn dlx @yarnpkg/sdks vscode` for VS Code support

**After adding/updating dependencies**, commit the changes to `.yarn/cache` and `.pnp.cjs`.

### Turborepo

Turborepo handles task orchestration with caching:
- Build artifacts are cached in `.turbo/`
- Remote caching can be enabled for CI

### Biome

Biome (v2.x) handles linting and formatting:
- 2 spaces, 100 char line width
- Single quotes, semicolons always, trailing commas
- CSS, HTML, GraphQL formatting enabled
- Nursery (experimental) lint rules enabled
- Uses `.gitignore` for file exclusions

### Lefthook

Git hooks are managed by lefthook:
- Pre-commit: Runs Biome on staged files
- Commit-msg: Validates conventional commit format

## Conventional Commits

All commits must follow the conventional commits format:
```
<type>(<scope>): <description>

[optional body]
```

**Rules:**
- Use imperative mood in the description ("add feature" not "added feature" or "adds feature")
- Don't capitalize the first letter of the description
- No period at the end of the description
- Keep the subject line under 72 characters
- Scope is optional but encouraged

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

**Examples:**
- `feat(auth): add login functionality`
- `fix(api): handle null response from server`
- `chore: update dependencies`
- `refactor(core): simplify error handling logic`

## Node/Yarn Versions

- Node.js: 24.13.0 (see `.nvmrc`, `.node-version`, `.tool-versions`)
- Yarn: 4.12.0 (managed via corepack)

To set up:
```bash
corepack enable
yarn install
```
