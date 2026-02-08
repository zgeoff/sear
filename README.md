<div align="center">

<img src="logo.png" alt="sear" width="128" />

# sear

**Real-time screen OCR and computer vision framework**

[![CI](https://github.com/zgeoff/sear/actions/workflows/main.yml/badge.svg?branch=main)](https://github.com/zgeoff/sear/actions/workflows/main.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org)
[![Yarn](https://img.shields.io/badge/yarn-4.12.0-2C8EBB.svg)](https://yarnpkg.com)
[![TypeScript](https://img.shields.io/badge/typescript-5.9-3178C6.svg)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Getting Started](#getting-started) • [Commands](#commands) • [Architecture](#architecture) •
[Development Workflow](#development-workflow) • [License](#license)

</div>

<br />

## Getting Started

Coming soon.

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

A modular, job-driven pipeline for capturing window/screen content and running OCR and CV analysis
jobs. Each capture region (ROI) is independently scheduled, and results flow through a reactive
pipeline built on Zustand stores.

```
sear/
├── apps/          # Applications (Electron-based inspector, etc.)
├── packages/      # Shared libraries (@sear/core, @sear/tesseractjs, @sear/opencvjs, etc.)
├── docs/          # Technical specs and design documents
├── biome.json     # Linting and formatting
├── turbo.json     # Build orchestration
└── package.json   # Workspace root
```

### Stack

- **Runtime** — Node.js 24+ / Electron
- **UI** — React, Zustand
- **OCR** — Tesseract.js
- **Computer Vision** — OpenCV.js
- **Package Manager** — Yarn Berry (PnP + Zero Installs)
- **Build System** — Turborepo
- **Linting/Formatting** — Biome
- **Testing** — Vitest
- **Git Hooks** — Lefthook

## Development Workflow

This project uses an AI-assisted development workflow — specs are the source of truth, task state
lives in GitHub Issues, and agents handle planning, implementation, and review. A TUI control plane
(`yarn agentic-workflow`) orchestrates it all.

See [`docs/specs/workflow/`](docs/specs/workflow/) for full specifications.

## License

[MIT](LICENSE)
