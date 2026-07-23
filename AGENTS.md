# ello

TypeScript monorepo for a process-isolated AI coding agent. `@ello/agent` owns the App Server; `@ello/tui` owns the JSON-RPC client, CLI, and Ink-based terminal UI.

## STRUCTURE

```
ello/
├── packages/
│   ├── ello-agent/             # App Server: model execution, tools, permissions, storage, workspace, skills, memory
│   └── ello-tui/               # Client: CLI (commander), Ink TUI, JSON-RPC client, transports
├── docs/                        # Chinese documentation
├── eslint.config.js             # Flat config: feature boundaries, import order, file naming
├── tsconfig.base.json           # ES2023, NodeNext, strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess
├── package.json                 # Workspace root (pnpm@11)
└── pnpm-workspace.yaml          # packages/*
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Agent features | `packages/ello-agent/src/features/` | 11 feature modules (agent, artifact, config, fs, memory, model, skill, task, thread, tool, workspace) |
| App composition | `packages/ello-agent/src/app.ts` | Single composition root — creates all features, wires routes |
| Server entry | `packages/ello-agent/src/main.ts` | Process entry for child-process spawning (`@ello/agent/server-entry`) |
| Protocol schemas | `packages/ello-agent/src/protocol/v1/` | Zod-validated JSON-RPC requests/responses/notifications |
| CLI entry | `packages/ello-tui/src/cli/main.ts` | Commander.js; binary `ello` |
| TUI app | `packages/ello-tui/src/tui/App.tsx` | Ink render entry |
| Client API | `packages/ello-tui/src/client/` | ThreadClient, TurnClient, event-reducer |
| Build system | `packages/*/scripts/build.mjs` | Custom atomic-swap tsc builds |
| Lint rules | `eslint.config.js` | Feature-boundary zones, TUI import restrictions |
| Database | `packages/ello-agent/src/infra/database/` | SQLite via better-sqlite3 + drizzle-orm |

## CONVENTIONS

- **ESM-only** (`"type": "module"` in all package.json)
- **TypeScript**: Strict, ES2023, NodeNext, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- **Formatting**: Prettier — single quotes, trailing commas, 80 char width, 2-space indent
- **File naming**: kebab-case (`.ts`), PascalCase (`.tsx`)
- **Import order**: builtin → external → internal → parent → sibling → index (blank lines between groups)
- **Feature boundaries**: Agent features import each other only through public `index.ts` entries
- **Package boundary**: TUI may only import `@ello/agent/protocol` — never `@ello/agent` root or internals
- **Documentation**: Agent source files require Chinese JSDoc headers (Args/Returns/Throws)
- **Testing**: Vitest, tests grouped by business capability under `packages/*/tests/<module>/`
- **Build**: Custom `build.mjs` with atomic dist swap; `verify-dist.mjs` enforces architecture boundaries post-build

## ANTI-PATTERNS

- Do NOT use CommonJS (`require`) — ESM imports only
- Do NOT import feature internals — use public `index.ts` barrel exports
- Do NOT import `@ello/agent` from TUI — only `@ello/agent/protocol`
- Do NOT use cyclic imports (enforced by ESLint, external ignored)
- Do NOT exceed 1000 lines/file (400 lines/function); 1600 for tests
- Do NOT mix languages in comments — agent source uses Chinese documentation

## UNIQUE STYLES

- **Agent feature pattern**: each feature has `index.ts` (public API), `routes.ts` (RPC routes), internal implementation files
- **System prompt templates**: Markdown files in `features/agent/context/prompts/*.md`
- **Bundled subagents**: Markdown definitions in `features/agent/subagents/bundled/*.md`
- **Config paths**: `ELLO_HOME` env var (default `~/.ello`) for config.yaml, mcp.json, state.db
- **Custom verify scripts**: `verify-source-comments.mjs` validates Chinese docs via AST; `verify-dist.mjs` blocks contaminated builds

## COMMANDS

```bash
pnpm install              # Install all workspace dependencies
pnpm build                # Build all packages (atomic swap)
pnpm typecheck            # Type check all packages
pnpm lint                 # ESLint all packages
pnpm test                 # Vitest all packages
pnpm --filter @ello/tui run ello --help   # Run CLI
pnpm --filter @ello/agent run verify-comments  # Validate Chinese docs
```

## NOTES

- No turborepo/nx — vanilla pnpm workspaces with `pnpm -r` recursive scripts
- `eslint.config.js` lists `repo` as a feature name but `features/repo/` does not exist — dead config
- CI: GitHub Actions (`.github/workflows/ci.yml`) — Node 24, pnpm 11.11.0, sequential build→lint→typecheck→test
- `pnpm-workspace.yaml` `allowBuilds` permits native builds for better-sqlite3, esbuild, protobufjs, unrs-resolver
