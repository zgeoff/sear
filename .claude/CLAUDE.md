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

### Test orchestration

Turborepo is the test orchestrator. Each package owns its own vitest instance — there is no root-level vitest or vitest workspace config.

**Running tests:**
```bash
yarn test                           # Run all tests (turbo run test)
yarn workspace <pkg> test           # Run tests for single package
yarn workspace <pkg> test --watch   # Watch mode
```

Do not invoke `vitest` directly. Always go through `yarn test` or `yarn workspace`.

**Package requirements:** Every package that has tests must have all three of:
1. `vitest` in `devDependencies` (pinned, like all deps)
2. `vitest.config.ts`
3. `"test": "vitest run"` in `scripts`

Packages without tests simply omit the `test` script — Turborepo skips them automatically.

### Never test TypeScript types

Do not write tests that only verify type-level behavior (e.g., `expectTypeOf`, `type-fest` helpers, assignability checks). Types are validated by `tsc` — testing them adds no value.

### Use `test`, never `describe`/`it`

```ts
// Correct
import { test, expect } from 'vitest';

test('it parses valid input', () => { ... });
test('it throws on empty string', () => { ... });

// Wrong — do not use describe or it
describe('parser', () => {
  it('parses valid input', () => { ... });
});
```

### Test naming

Start every test name with "it" — each test reads as a behavioral sentence about the subject under test. Describe behavior and outcomes, not implementation details. Avoid method names, parameter names, or internal component names in the test string.

```ts
// Correct — behavioral, reads as "it ..."
test('it returns an unsubscribe function from the event emitter', () => { ... });
test('it invokes the cancel handler when the cancel command is received', () => { ... });
test('it passes the full command object to the handler', () => { ... });

// Wrong — implementation-focused, names internals
test('on() returns an unsubscribe function', () => { ... });
test('cancelPlanner command invokes the cancelPlanner handler', () => { ... });
test('dispatcher passes full command object to handler', () => { ... });
```

### No `beforeEach`/`beforeAll` — use a `setupTest()` helper

```ts
// Correct
function setupTest() {
  const store = createStore();
  const handler = buildHandler(store);
  return { store, handler };
}

test('it updates the store when an event is processed', () => {
  const { store, handler } = setupTest();
  handler.process(event);
  expect(store.getState().count).toBe(1);
});

// Wrong — do not use beforeEach or beforeAll
let store: Store;
beforeEach(() => {
  store = createStore();
});
```

### Never test logging

Do not spy on `console.log`, `console.error`, or similar logging functions. Do not assert that a logger or `logError` callback was called. Logging is an implementation detail — tests should verify observable behavior (return values, thrown errors, state changes), not side-effect noise.

```ts
// Wrong — testing logging output
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
await doThing();
expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed'));

// Wrong — asserting a logError callback
expect(logError).toHaveBeenCalledWith('SpecPoller poll cycle failed', expect.any(Error));

// Correct — test the observable outcome instead
const result = await doThing();
expect(result).toEqual(EMPTY_RESULT);
```

### Test utilities

Place mock factories and test helpers under `src/test-utils/` within each package, one per file following the standard file organization rules:

```
src/test-utils/create-mock-github-client.ts   → export createMockGitHubClient
src/test-utils/build-valid-config.ts          → export buildValidConfig
```

### Filesystem mocking

Use `memfs` as a global mock for `node:fs/promises`. Configure it as a per-package vitest setup file:

```ts
// vitest.setup.ts
import { vi } from 'vitest';
import { fs } from 'memfs';

vi.mock('node:fs/promises', () => fs.promises);
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
  },
});
```

Do not mock `node:fs/promises` inline in individual test files — rely on the setup file.

### MSW (Mock Service Worker)

MSW is available for HTTP mocking in tests. Set up handlers per-package as needed.

## Dependencies

Always install dependencies via `yarn add`, never by editing `package.json` directly. Yarn must run its resolution and PnP toolchain for dependencies to work.

```bash
# Correct
yarn workspace @sear/agentic-workflow add zustand --exact
yarn workspace @sear/agentic-workflow add -D vitest --exact

# Wrong — editing package.json by hand and running yarn install
```

Always use **pinned (exact) versions** (`--exact` flag) — no ranges, carets, tildes, or wildcards.

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

### File organization

Each file has **one primary export** and is named after it in **kebab-case**. Factory functions use the `create-` prefix (e.g., `createSpecPoller` → `create-spec-poller.ts`).

Don't put multiple public APIs in a single file — split them into separate files instead.

```
// Wrong — multiple unrelated exports in one file
config.ts → export validateConfig, buildResolvedConfig, loadConfig

// Correct — one primary export per file, named after it
config/validate-config.ts → export validateConfig
config/load-config.ts     → export loadConfig
config/types.ts           → shared types for the directory
config/constants.ts       → shared constants for the directory
```

**Secondary exports** are allowed when they exist to support the primary export — most commonly in mocks or test utilities where callers need access to internals for assertions:

```ts
// mocks/handlers/send-email.ts
// Primary export: the MSW handler
export const sendEmail = http.post('/api/send-email', ...);

// Secondary export: allows tests to assert what was sent
export const mockEmails: SentEmail[] = [];
```

### Module directory structure

Each non-trivial module gets its own directory. The directory is named after the module (without the `create-` prefix), and contains the implementation file, its tests, types, and any helpers:

```
// Wrong — flat files in a parent directory
engine/create-event-emitter.ts
engine/create-event-emitter.test.ts
engine/create-command-dispatcher.ts
engine/create-command-dispatcher.test.ts

// Correct — each module in its own directory
engine/event-emitter/create-event-emitter.ts
engine/event-emitter/create-event-emitter.test.ts
engine/event-emitter/types.ts
engine/command-dispatcher/create-command-dispatcher.ts
engine/command-dispatcher/create-command-dispatcher.test.ts
engine/pollers/create-spec-poller.ts
engine/pollers/create-spec-poller.test.ts
engine/pollers/parse-frontmatter-status.ts
engine/pollers/parse-frontmatter-status.test.ts
```

### Module types

Each module directory has a `types.ts` file that contains the module's exported type definitions — the public API contract for that module. This keeps types discoverable and separates interface from implementation.

**Goes in `types.ts`:**
- All exported types (interfaces, type aliases, discriminated unions)
- Configuration/dependency types (`*Config`, `*Deps`, `*Params`)
- Return/result types (`*Result`, the module's main interface type)
- Types shared across multiple files in the same directory

**Stays in the implementation file:**
- Unexported types used only within that file (internal state, helper types)
- Constants derived from types (e.g., default values, empty results)

```ts
// recovery/types.ts — the module's public API types
export type RecoveryConfig = { octokit: GitHubClient; owner: string; repo: string };
export type StartupRecoveryResult = { snapshot: IssuePollerSnapshot };
export type Recovery = {
  performStartupRecovery(): Promise<StartupRecoveryResult>;
  performCrashRecovery(params: CrashRecoveryParams): Promise<void>;
};

// recovery/create-recovery.ts — imports types, keeps internals private
import type { RecoveryConfig, Recovery } from './types.js';

// Internal-only type — fine to keep here, not exported
type SnapshotCache = Map<number, IssueSnapshotEntry>;

export function createRecovery(config: RecoveryConfig): Recovery { ... }
```

When a file contains **only type definitions** and no runtime code, it should be a `types.ts` inside a module directory — not a standalone file in a parent directory:

```
// Wrong — standalone types-only file in parent directory
engine/github-client.ts  (contains only type definitions)

// Correct — types in a module directory
engine/github-client/types.ts
```

### Function ordering within a file

The primary export comes **first** in the file. Unexported helpers follow below it, ordered from highest-level to lowest-level. This is a strict rule — never define helpers above the primary export.

Unexported types and constants that configure the primary export may appear before it.

```ts
// create-spec-poller.ts

// Types and constants — OK above primary export
type SpecSnapshot = { treeSHA: string | null };
const EMPTY_RESULT: SpecPollerBatchResult = { changes: [], commitSHA: '' };

// Primary export — first function in the file
export function createSpecPoller(config: SpecPollerConfig): SpecPoller {
  const snapshot = initSnapshot();
  async function poll() {
    const treeSHA = await getSpecsDirTreeSHA(config);
    // ...
  }
  return { poll };
}

// Higher-level helper
async function getSpecsDirTreeSHA(config: SpecPollerConfig): Promise<string | null> {
  const tree = await fetchTree(config);
  return findEntry(tree);
}

// Lowest-level helpers
async function fetchTree(config: SpecPollerConfig) { ... }
function findEntry(tree: TreeEntry[]) { ... }
```

### Type assertions
Never use type assertions (`as`) unless there is a genuine TypeScript error that cannot be resolved through correct typing. If the types are wrong, fix the types — don't cast around them. This includes `as unknown as X`, `as Record<string, unknown>`, `as any`, and similar escape hatches.

```ts
// Wrong — unnecessary cast, fix the function signature instead
expect(() => validateConfig(config as Record<string, unknown>)).not.toThrow();

// Correct — types match, no cast needed
expect(() => validateConfig(config)).not.toThrow();
```

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

### No inline types

Never use inline object types — not in function arguments, return types, interface method signatures, or generic parameters. Always define named types.

```ts
// Wrong — inline types everywhere
function getROIFromBBox(bbox: { x: number; y: number; w: number; h: number }): ROIConfig { ... }

type GitHubClient = {
  pulls: {
    list(params: { owner: string; repo: string }): Promise<{ data: { number: number }[] }>;
  };
};

// Correct — named types
type BBox = { x: number; y: number; w: number; h: number };
function getROIFromBBox(bbox: BBox): ROIConfig { ... }

type PullsListParams = { owner: string; repo: string };
type PullsListResult = { data: { number: number }[] };

type GitHubClient = {
  pulls: {
    list(params: PullsListParams): Promise<PullsListResult>;
  };
};
```

### Flat control flow

Avoid nested `if` statements. Flatten with guard clauses, early returns, or sequential conditions. Each level of nesting makes code harder to follow.

```ts
// Wrong — nested ifs
if (combinedStatus.total_count > 0) {
  if (combinedStatus.state === 'success') {
    ciStatus = 'success';
  } else if (combinedStatus.state === 'failure') {
    ciStatus = 'failure';
  }
}

// Correct — flat guard clauses
if (combinedStatus.total_count > 0 && combinedStatus.state === 'success') {
  ciStatus = 'success';
}
if (combinedStatus.total_count > 0 && combinedStatus.state === 'failure') {
  ciStatus = 'failure';
}

// Also correct — early return to avoid nesting
function processItem(item: Item): Result {
  if (!item.isValid) return defaultResult;
  if (!item.hasData) return defaultResult;
  // main logic at top level, no nesting
  return computeResult(item.data);
}
```

### Exports
Always export inline at the declaration site. Never collect exports at the bottom of a file.

```ts
// Correct — inline exports
export type EventHandler = (event: EngineEvent) => void;

export type EventEmitter = {
  on(handler: EventHandler): Unsubscribe;
  emit(event: EngineEvent): void;
};

export function createEventEmitter(): EventEmitter {
  // ...
}

// Wrong — barrel exports at the bottom
function createEventEmitter(): EventEmitter { ... }
export { createEventEmitter };
export type { EventEmitter, EventHandler };
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
