<div align="center">

# sear

**Something cool is cooking**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org)
[![Yarn](https://img.shields.io/badge/yarn-4.12.0-2C8EBB.svg)](https://yarnpkg.com)
[![TypeScript](https://img.shields.io/badge/typescript-5.9-3178C6.svg)](https://www.typescriptlang.org)

<br />

[Getting Started](#getting-started) •
[Commands](#commands) •
[Architecture](#architecture) •
[License](#license)

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

| Command | Description |
|---------|-------------|
| `yarn build` | Build all packages and apps |
| `yarn test` | Run tests across the monorepo |
| `yarn lint` | Lint all packages |
| `yarn typecheck` | TypeScript type checking |
| `yarn format` | Format code with Biome |
| `yarn check` | Run lint, typecheck, and test |

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

## License

[MIT](LICENSE)

</div>
