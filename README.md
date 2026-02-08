<div align="center">

# sear

**Something cool is cooking**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org)
[![Yarn](https://img.shields.io/badge/yarn-4.12.0-2C8EBB.svg)](https://yarnpkg.com)
[![TypeScript](https://img.shields.io/badge/typescript-5.9-3178C6.svg)](https://www.typescriptlang.org)

<br />

[Getting Started](#getting-started) • [Commands](#commands) • [Architecture](#architecture) •
[Development Workflow](#development-workflow) • [License](#license)

</div>

<br />

## Getting Started

```bash
# Clone the repo (zero install - no yarn install needed)
git clone git@github.com:zgeoff/sear.git
cd sear

# Enable corepack for Yarn
corepack enable

# You're ready to go
yarn build
```

## Commands

| Command          | Description                   |
| ---------------- | ----------------------------- |
| `yarn build`     | Build all packages and apps   |
| `yarn test`      | Run tests across the monorepo |
| `yarn lint`      | Lint all packages             |
| `yarn typecheck` | TypeScript type checking      |
| `yarn format`    | Format code with Biome        |
| `yarn check`     | Run lint, typecheck, and test |

### Working with packages

```bash
# Run a command in a specific package
yarn workspace @sear/core build

# Run a command with Turborepo filtering
yarn turbo run build --filter=@sear/core
```

## Architecture

```
sear/
├── apps/          # Applications (web, CLI, etc.)
├── packages/      # Shared libraries and utilities
├── biome.json     # Linting and formatting
├── turbo.json     # Build orchestration
└── package.json   # Workspace root
```

### Stack

- **Runtime** — Node.js 24+
- **Package Manager** — Yarn Berry (PnP + Zero Installs)
- **Build System** — Turborepo
- **Linting/Formatting** — Biome
- **Testing** — Vitest
- **Git Hooks** — Lefthook

## Development Workflow

This project uses an AI-assisted development workflow where specifications are the source of truth
and all task state lives in GitHub Issues.

### Lifecycle

1. **Spec** — Human authors and approves a specification using structured templates
2. **Plan** — A Planner agent decomposes the spec into scoped GitHub Issues with labels,
   dependencies, and priority
3. **Implement** — Human assigns a task; an Implementor agent writes code and tests in an isolated
   git worktree
4. **Review** — A Reviewer agent verifies acceptance criteria, spec conformance, and code quality
5. **Integrate** — Human merges the approved PR and closes the issue

### Roles

| Role            | Responsibility                                                      |
| --------------- | ------------------------------------------------------------------- |
| **Human**       | Authors specs, assigns tasks, resolves escalations, merges PRs      |
| **Planner**     | Decomposes specs into task issues                                   |
| **Implementor** | Executes assigned tasks (one per agent, parallelized via worktrees) |
| **Reviewer**    | Reviews PRs against spec and acceptance criteria                    |

Only the Human can approve spec changes and merge code. Agents escalate ambiguity rather than
interpret.

### Control Plane

A TUI application (`yarn agentic-workflow`) orchestrates the workflow — polling GitHub for state
changes, auto-dispatching agents where policy allows, and surfacing actionable items for human
decision-making. See [`docs/specs/workflow/`](docs/specs/workflow/) for full specifications.

## License

[MIT](LICENSE)

</div>
