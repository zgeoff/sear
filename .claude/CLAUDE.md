# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**sear** — A real-time screen OCR and computer vision framework for Windows.

A modular, job-driven pipeline for capturing window/screen content and running OCR and CV analysis jobs. Designed for DX-first development.

- **Stack:** TypeScript, Electron, React, Zustand, Tesseract.js, OpenCV.js
- **Monorepo:** Yarn Berry workspaces

## Setup

- Node.js: 24.13.0 (see `.nvmrc`, `.node-version`, `.tool-versions`)
- Yarn: 4.12.0 (managed via corepack)

```bash
corepack enable
yarn install
```

## Architecture

### Directory Structure

- `packages/` - Shared libraries and utilities
- `apps/` - Applications (Electron-based inspector, etc.)
- `docs/` - Technical specs and design documents

<!-- TODO: Add ## Documentation section with format guidelines, templates, etc. -->

### Package Namespace

All packages use the `@sear/` npm scope.

### Planned Packages

| Package | Description | Status |
|---------|-------------|--------|
| `@sear/core` | Pipeline, scheduler, job management | Planned |
| `@sear/tesseractjs` | Tesseract.js wrapper for OCR | Planned |
| `@sear/opencvjs` | OpenCV.js wrapper for CV/template matching | Planned |
| `@sear/utils` | Shared utilities (e.g., `createStableTextTracker`) | Planned |

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

## Naming Conventions

### Acronym Casing
Acronyms and initialisms should be **uppercase** in both type names and property names:

```ts
type ROIConfig = { ... };
type CVConfig = { templateID: string };
const jobID = 'abc';
const roiID = 'def';
```

### Function Naming

**Core actions:**
```ts
getUser(userId)                 // retrieve existing data (no side effects)
createUser(userInput)           // persist/allocate/register (changes the world)
buildUserEntity(userDto)        // assemble in-memory object (pure, no I/O)
parseAuthHeader(header)         // raw input -> structured data
validateRunConfig(runConfig)    // enforce constraints (no mutation)
updateUser(userId, patch)       // mutate existing persisted state
deleteUser(userId)              // remove persisted state
executeModelRun(runId)          // orchestrate workflow (side effects likely)
```

**Predicates:**
```ts
isAdmin(user)                   // factual classification / property
canDelete(user, post)           // capability check (given permissions/state)
shouldScrubKey(key)             // policy decision / heuristic gate
```

**Transformers:**
```ts
transformQueryParams(params)    // structural input -> output mapping (pure)
scrubQueryString(url)           // remove/replace sensitive values (privacy/security)
serializeRunConfig(runConfig)   // convert structured -> string/JSON (format transform)
```

## Code Style

### Pattern Matching
Prefer `ts-pattern` over switch statements for discriminated unions:

```ts
import { match } from 'ts-pattern';

// Preferred
match(event)
  .with({ type: 'health.updated' }, (e) => handleHealth(e.data))
  .with({ type: 'mana.updated' }, (e) => handleMana(e.data))
  .exhaustive();

// Avoid
switch (event.type) {
  case 'health.updated': ...
  case 'mana.updated': ...
}
```

### Function Arguments
Never use inline types for function arguments. Always define named types:

```ts
// Preferred
type BBox = { x: number; y: number; w: number; h: number };
function getROIFromBBox(bbox: BBox): ROIConfig { ... }

// Avoid
function getROIFromBBox(bbox: { x: number; y: number; w: number; h: number }): ROIConfig { ... }
```

## Terminology

| Term | Definition |
|------|------------|
| **ROI** | Region of Interest — a rectangular area of a captured frame to analyze |
| **CV** | Computer Vision — image analysis techniques (template matching, object detection) |
| **OCR** | Optical Character Recognition — extracting text from images |
| **Job** | A scheduled unit of work that analyzes an ROI (either OCR or CV) |

## References

- [Yarn Berry (v4)](https://yarnpkg.com/) — Package manager with PnP
- [Turborepo](https://turbo.build/repo) — Monorepo build orchestration
- [Biome](https://biomejs.dev/) — Linting and formatting
- [Vitest](https://vitest.dev/) — Testing framework
- [ts-pattern](https://github.com/gvergnaud/ts-pattern) — Pattern matching for TypeScript
- [Lefthook](https://github.com/evilmartians/lefthook) — Git hooks manager
- [Zustand](https://zustand-demo.pmnd.rs/) — State management
- [Tesseract.js](https://tesseract.projectnaptha.com/) — OCR engine
- [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html) — Computer vision
