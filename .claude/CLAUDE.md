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
- `agentic-workflow/` - Agentic workflow control plane (`@sear/agentic-workflow`)
- `docs/` - Technical specs and design documents

### Packages

All packages use the `@sear/` npm scope.

| Package | Description | Status |
|---------|-------------|--------|
| `@sear/agentic-workflow` | Workflow control plane (engine + TUI) | Active |
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

## Commands

```bash
yarn build          # Build all packages/apps
yarn test           # Run tests across all packages (vitest via Turborepo)
yarn test:sh        # Run BATS shell tests (scripts/**/*.test.sh)
yarn lint           # Lint all packages
yarn format         # Format code with Biome
yarn format:check   # Check formatting without writing
yarn check          # Run lint, typecheck, and test (CI command)
yarn typecheck      # TypeScript type checking
```

### Single Package Commands

```bash
yarn workspace <package-name> <command>
# Example: yarn workspace @sear/agentic-workflow test
```

## Tooling

### Yarn PnP + Zero Installs

This repo uses Yarn Plug'n'Play (PnP) with Zero Installs enabled:

- No `node_modules` folder
- Dependencies are stored in `.yarn/cache` and committed to git
- IDE integration: Run `yarn dlx @yarnpkg/sdks vscode` for VS Code support

**After adding/updating dependencies**, commit the changes to `.yarn/cache` and `.pnp.cjs`.

**Installing dependencies:** Always use `yarn add` with pinned versions — never edit `package.json` directly:

```bash
yarn workspace @sear/agentic-workflow add zustand --exact
yarn workspace @sear/agentic-workflow add -D vitest --exact
```

**Inspecting dependency types:** Dependencies in `.yarn/cache` are zip archives — do not attempt to read, grep, or unzip them directly. If you need to inspect a dependency's type definitions, use `yarn unplug <package>` to extract it to `.yarn/unplugged/` where files are readable on disk. Alternatively, rely on TypeScript error messages and existing type imports in the codebase rather than reading `.d.ts` files from dependencies.

### Turborepo

Turborepo handles task orchestration with caching:
- Build artifacts are cached in `.turbo/`
- Filter by package: `yarn turbo run build --filter=<package-name>`

### Biome

Biome (v2.x) handles linting and formatting. The full config is in `biome.jsonc` — highlights:
- 2 spaces, 100 char line width, single quotes, semicolons always, trailing commas
- Strict rule set including nursery rules: `noNonNullAssertion`, `useExplicitType`, `useConsistentTypeDefinitions` (interface), `useConsistentMethodSignatures` (property-style), `noMagicNumbers` (off in tests), `noContinue`, `noIncrementDecrement`, `useBlockStatements`
- CSS, HTML, GraphQL formatting enabled
- Uses `.gitignore` for file exclusions

### Lefthook

Git hooks are managed by lefthook:
- Pre-commit: Runs Biome on staged files
- Commit-msg: Validates conventional commit format

### GitHub

When interacting with GitHub (issues, PRs, labels, etc.), activate the `/github-workflow` skill.

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
- All exported interfaces and type aliases (discriminated unions, intersections)
- Configuration/dependency types (`*Config`, `*Deps`, `*Params`)
- Return/result types (`*Result`, the module's main interface type)
- Types shared across multiple files in the same directory

**Stays in the implementation file:**
- Unexported types used only within that file (internal state, helper types)
- Constants derived from types (e.g., default values, empty results)
- **Component prop types** — a component's props type is defined in the same file as the component, directly above it. Props types are consumed by exactly one component and should be colocated, not in `types.ts`

```ts
// list/list.tsx — props type lives with its component
export interface ListProps { label: string; items: ListItem[]; focused: boolean }

export function List(props: ListProps) { ... }
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

type SpecSnapshot = { ... };              // unexported types/constants OK above
const EMPTY_RESULT: SpecPollerBatchResult = { ... };

export function createSpecPoller(config: SpecPollerConfig): SpecPoller { ... }

// helpers: highest-level first, lowest-level last
async function getSpecsDirTreeSHA(config: SpecPollerConfig): Promise<string | null> { ... }
async function fetchTree(config: SpecPollerConfig) { ... }
function findEntry(tree: TreeEntry[]) { ... }
```

### Exports

Always export inline at the declaration site. Never collect exports at the bottom of a file.

```ts
// Correct — inline exports
export type EventHandler = (event: EngineEvent) => void;
export interface EventEmitter { ... }
export function createEventEmitter(): EventEmitter { ... }
```

### Naming

**Acronym casing:** Acronyms and initialisms should be **uppercase** in both type names and property names:

```ts
interface ROIConfig { ... }
interface CVConfig { templateID: string }
const jobID = 'abc';
const roiID = 'def';
```

**Function naming:** Use verb prefixes that signal the function's behavior:

```ts
// Core actions
getUser(userId)                 // retrieve existing data (no side effects)
createUser(userInput)           // persist/allocate/register (changes the world)
buildUserEntity(userDto)        // assemble in-memory object (pure, no I/O)
parseAuthHeader(header)         // raw input -> structured data
validateRunConfig(runConfig)    // enforce constraints (no mutation)
updateUser(userId, patch)       // mutate existing persisted state
deleteUser(userId)              // remove persisted state
executeModelRun(runId)          // orchestrate workflow (side effects likely)

// Predicates
isAdmin(user)                   // factual classification / property
canDelete(user, post)           // capability check (given permissions/state)
shouldScrubKey(key)             // policy decision / heuristic gate

// Transformers
transformQueryParams(params)    // structural input -> output mapping (pure)
scrubQueryString(url)           // remove/replace sensitive values (privacy/security)
serializeRunConfig(runConfig)   // convert structured -> string/JSON (format transform)
```

### No inline types

Never use inline object types — not in function arguments, return types, interface method signatures, or generic parameters. Always define named types.

```ts
// Wrong — inline types
function getROIFromBBox(bbox: { x: number; y: number; w: number; h: number }): ROIConfig { ... }

// Correct — named types
interface BBox { x: number; y: number; w: number; h: number }
function getROIFromBBox(bbox: BBox): ROIConfig { ... }
```

### Type assertions

Never use type assertions (`as`) unless there is a genuine TypeScript error that cannot be resolved through correct typing. If the types are wrong, fix the types — don't cast around them. This includes `as unknown as X`, `as Record<string, unknown>`, `as any`, and similar escape hatches.

**In tests:** Use structural matchers (`toMatchObject`, `toStrictEqual`, `expect.objectContaining`) instead of casting to assert properties — they verify shape without type casts and produce better error messages:

```ts
// Wrong — casting to assert a property
const failNotif = notifications.find((n) => n.eventType === 'agentFailed');
expect((failNotif as AgentFailedNotification).logFilePath).toBe('/logs/agent.log');

// Correct — structural matcher, no cast needed
expect(notifications).toContainEqual(
  expect.objectContaining({
    eventType: 'agentFailed',
    logFilePath: '/logs/agent.log',
  }),
);
```

**Cast-free patterns:**

Narrow third-party interfaces at module boundaries — depend on what you use, not the full external type:
```ts
// Wrong — depending on full SDK type forces casts in tests
import type { Query } from '@anthropic-ai/sdk';
type QueryFactory = (params: Params) => Promise<Query>;

// Correct — narrow interface at the boundary
type AgentQuery = AsyncIterable<unknown> & { interrupt: () => Promise<void> };
type QueryFactory = (params: Params) => Promise<AgentQuery>;
```

Use Record lookups instead of Set checks when parsing string unions from untrusted input:
```ts
// Wrong — Set.has() doesn't narrow, requires cast
const VALID = new Set(['a', 'b', 'c']);
if (VALID.has(value)) return value as MyUnion;

// Correct — Record lookup returns the union type directly
const VALID: Record<string, MyUnion> = { a: 'a', b: 'b', c: 'c' };
return VALID[value] ?? defaultValue;
```

### Custom type guards for complex narrowing

When narrowing `unknown` or loosely-typed values (e.g., SDK responses, parsed JSON, message payloads), extract the narrowing logic into a named type guard function. Inline chains of `typeof x === 'object' && x !== null && 'field' in x && typeof x.field === 'number'` are hard to read and easy to get wrong. A type guard encapsulates the check, names the intent, and narrows the type in one step.

```ts
// Wrong — inline narrowing chain
if (typeof usage === 'object' && usage !== null && 'input_tokens' in usage && ...) { ... }

// Correct — named type guard
function isUsage(value: unknown): value is Usage {
  return typeof value === 'object' && value !== null && 'input_tokens' in value && ...;
}
```

Type guards should be placed as unexported helpers below the primary export, following the standard function ordering rules.

### No non-null assertions — use `tiny-invariant`

Biome enforces `noNonNullAssertion`. When you need to narrow a nullable type, use `tiny-invariant` — it crashes with a meaningful message and narrows the type:

```ts
import invariant from 'tiny-invariant';

const issue = issues.find((i) => i.number === issueNumber);
invariant(issue, `issue #${issueNumber} must exist in the tracked set`);
const title = issue.title; // type is narrowed, no cast needed
```

### No parameter destructuring

Never destructure object parameters in function signatures. Access properties from the named parameter instead. The only acceptable use of destructuring is in a standalone assignment to leverage spread syntax for property omission or selection.

```ts
// Wrong — destructuring in the function signature
function SomeComponent({ children }: SomeComponentProps) { ... }
function createPoller({ interval, octokit }: PollerConfig) { ... }

// Correct — named parameter, access properties directly
function SomeComponent(props: SomeComponentProps) {
  return <div>{props.children}</div>;
}

function createPoller(config: PollerConfig) {
  const timer = setInterval(config.interval);
}

// Acceptable — destructuring for spread/omission in an assignment
const { children, ...rest } = props;
const { secret, ...safeConfig } = config;
```

### Pattern matching

Prefer `ts-pattern` over switch statements for discriminated unions:

```ts
import { match } from 'ts-pattern';

match(event)
  .with({ type: 'health.updated' }, (e) => handleHealth(e.data))
  .with({ type: 'mana.updated' }, (e) => handleMana(e.data))
  .exhaustive();
```

### Flat control flow

Prefer guard clauses and early returns over nested conditions. Biome enforces `useCollapsedIf`, `useCollapsedElseIf`, `noContinue`, and `useBlockStatements`, but the general principle of keeping control flow flat goes further:

```ts
function processItem(item: Item): Result {
  if (!item.isValid) { return defaultResult; }
  if (!item.hasData) { return defaultResult; }
  return computeResult(item.data);
}
```

### Prefer `async`/`await` over raw `Promise` chains

Always use `async`/`await` instead of `Promise.resolve()`, `Promise.reject()`, or `.then()` chains. This applies to both production code and test mocks.

```ts
// Wrong — raw Promise construction
function fetchData(): Promise<Data> { return Promise.resolve({ id: 1 }); }

// Correct — async/await
async function fetchData(): Promise<Data> { return { id: 1 }; }
```

### Spec pseudocode is sync for readability

Code examples in specifications omit `async`/`await`/`Promise<>` notation for brevity. When implementing, adapt signatures to be asynchronous wherever the implementation involves I/O or other async operations. Never use `void` to discard a `Promise` — if a call is async, the enclosing signature must reflect that.

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
import { test, expect } from 'vitest';

test('it parses valid input', () => { ... });
test('it throws on empty string', () => { ... });
```

### Test naming

Start every test name with "it" — each test reads as a natural-language behavioral sentence about the subject under test. Describe behavior and outcomes in plain English, not implementation details. Avoid variable names, field names, method names, event type strings, or internal component names in the test string.

```ts
// Correct — natural language, describes behavior
test('it flags the planner as not running when the planner completes', () => { ... });
test('it preserves the failure overlay when recovering from a crash', () => { ... });

// Wrong — leaks implementation details
test('it sets plannerRunning to false when Planner agentCompleted is emitted', () => { ... });
test('it does not clear lastFailure when issueStatusChanged has isRecovery true', () => { ... });
```

### No `beforeEach`/`beforeAll` — use a `setupTest()` helper

```ts
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
```

### Use `vi.waitFor` instead of manual `setTimeout` delays

Never use `await new Promise((resolve) => setTimeout(resolve, N))` to wait for async operations in tests. Use `vi.waitFor` to poll until assertions pass:

```ts
await vi.waitFor(() => {
  expect(events.some((e) => e.type === 'agentStarted')).toBe(true);
});
```

### Never test logging

Do not spy on `console.log`, `console.error`, or similar logging functions. Do not assert that a logger or `logError` callback was called. Logging is an implementation detail — tests should verify observable behavior (return values, thrown errors, state changes).

### Use `toStrictEqual`, never `toEqual`

Always use `toStrictEqual` — never `toEqual`. `toStrictEqual` catches undefined properties, sparse arrays, and class mismatches that `toEqual` silently ignores.

When asserting a subset of properties, use `toMatchObject` or asymmetric matchers (`expect.objectContaining`, `expect.any`) instead of asserting individual properties one at a time.

```ts
// Wrong — toEqual misses undefined vs missing, class mismatches
expect(result).toEqual({ issueCount: 2, recoveriesPerformed: 0 });

// Correct — toStrictEqual for full object assertion
expect(result).toStrictEqual({ issueCount: 2, recoveriesPerformed: 0 });

// Correct — toMatchObject for partial assertion (result may have other fields)
expect(result).toMatchObject({ issueCount: 2, recoveriesPerformed: 0 });
```

### Test utilities

Place mock factories and test helpers under `src/test-utils/` within each package, one per file following the standard file organization rules:

```
src/test-utils/create-mock-github-client.ts   → export createMockGitHubClient
src/test-utils/build-valid-config.ts          → export buildValidConfig
```

MSW is available for HTTP mocking. Set up handlers per-package as needed.

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
