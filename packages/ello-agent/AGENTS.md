# @ello/agent

App Server for ello. Owns provider credentials, model execution, tools, permissions, storage, workspace, skills, memory, and persistence. Clients connect via JSON-RPC 2.0 (`vscode-jsonrpc`) through stdio, WebSocket, or Unix socket transports.

## STRUCTURE

```
src/
├── main.ts                  # Process entry (spawned by TUI as child process)
├── app.ts                   # Composition root — creates features, wires routes, manages lifecycle
├── index.ts                 # Public export: createApp, AgentServer
├── features/                # 11 feature modules
│   ├── agent/               # Agent lifecycle, engine, system prompts, subagents, checkpoints, user-input
│   ├── thread/              # Thread/Turn/Item CRUD, compaction, goals, title generation, export
│   ├── tool/                # Tool registry, permissions engine, tool runtime (shell, fs, patch, search)
│   ├── workspace/           # Repository management, workspace CRUD, tmux integration
│   ├── config/              # YAML config loading, provider catalog, settings, templates
│   ├── model/               # AI SDK model adapters, provider registry, provider options
│   ├── memory/              # Memory storage, indexing, extraction, search tools
│   ├── skill/               # Skill activation, loader, search index
│   ├── task/                # Task board store, task events
│   ├── artifact/            # Artifact store (file-based)
│   └── fs/                  # Filesystem operations
├── protocol/                # JSON-RPC protocol layer
│   ├── v1/                  # Zod schemas: requests, responses, notifications, server-requests
│   ├── json-rpc.ts          # vsode-jsonrpc type helpers
│   ├── errors.ts            # AppServerError
│   └── version.ts
├── server/                  # Generic server transport layer
│   ├── server.ts            # AgentServer class (lifecycle, connection management)
│   ├── server-connection.ts # Per-connection state
│   ├── rpc/                 # Route dispatch, route type definitions
│   └── transport/           # stdio, websocket, listener factory
├── infra/                   # Shared infrastructure
│   ├── database/            # SQLite via better-sqlite3 + drizzle-orm, migrations
│   ├── telemetry/           # OpenTelemetry, Langfuse integration, turn tracing, usage store
│   ├── paths.ts             # ELLO_HOME path derivation
│   ├── filesystem.ts        # Filesystem helpers
│   ├── git.ts               # Git operations
│   └── weighted-search-index.ts
├── storage/                 # Persistence layer (currently threads/)
└── ids.ts                   # ID generation utilities
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Start a server instance | `src/app.ts` → `createApp()` | Returns `AgentServer`; wires all features |
| Process entry point | `src/main.ts` → `runAppServer()` | Parses `--listen`, `--root`, `--auth-token-env` |
| Add a new tool | `src/features/tool/internal/production.ts` | Add to tool array in `createProductionToolRuntime()` |
| Add a new RPC route | Feature `routes.ts` → merge in `src/app.ts` | Route must satisfy `RpcApplicationRouteTable` |
| Modify system prompts | `src/features/agent/context/prompts/*.md` | Nunjucks templates, injected as context sections |
| Add a bundled subagent | `src/features/agent/subagents/bundled/*.md` | Markdown definitions loaded at runtime |
| Database schema | `src/infra/database/schema.ts` + `migrations/` | Drizzle ORM table definitions + SQL migrations |
| Add a new feature | `src/features/<name>/` | Must have `index.ts` (public API), `routes.ts` (RPC routes) |
| Config file location | `src/features/config/paths.ts` | `ELLO_HOME` env var (default `~/.ello`) |

## CONVENTIONS

- **Feature pattern**: `index.ts` (public barrel) + `routes.ts` (RPC handlers) + internal files
- **Agent feature extra exports**: `agent` feature also exports `engine/index.ts` and `subagents/index.ts`
- **Chinese JSDoc**: All callable exports require Chinese doc headers with Args/Returns/Throws
- **Dependency direction**: Features → infra/protocol only; features import each other via public entries
- **Protocol isolation**: `protocol/v1/` is the only export consumed by TUI (`@ello/agent/protocol`)
- **Server isolation**: `server/` is a generic transport layer — cannot import product features

## ANTI-PATTERNS

- Do NOT add routes directly to `server/` — routes live in feature `routes.ts`, merged in `app.ts`
- Do NOT import `app.ts` from any feature — it's the composition root
- Do NOT import feature internals from other features or from `app.ts`
- Do NOT use `as any` / `@ts-ignore` / `@ts-expect-error`
- Do NOT add dependencies to `package.json` without justification

## UNIQUE STYLES

- **Atomic build**: `scripts/build.mjs` compiles to PID-temp dir, runs `verify-dist.mjs`, then atomically swaps `dist`
- **Dist verification**: `verify-dist.mjs` rejects builds containing React/Ink (server contamination)
- **Comment verification**: `scripts/verify-source-comments.mjs` validates Chinese documentation via AST
- **Change tracking**: Agent runs produce checkpoints (`features/agent/change/`) for plan-mode workflows
- **Goals subsystem**: `features/thread/goals/` manages persistent goals with tool integration

## COMMANDS

```bash
pnpm --filter @ello/agent build              # Build (atomic swap)
pnpm --filter @ello/agent test               # Vitest (tests/)
pnpm --filter @ello/agent typecheck          # tsc --noEmit (src + tests)
pnpm --filter @ello/agent lint               # ESLint src
pnpm --filter @ello/agent verify-comments    # Validate Chinese documentation
pnpm --filter @ello/agent verify-dist        # Validate build output
```

## NOTES

- `eslint.config.js` lists `repo` feature but `features/repo/` does not exist — ignore references to it
- `package.json` exports: `.` (server lifecycle), `./protocol` (Zod schemas for TUI), `./server-entry` (process entry)
- `main.ts` is never imported — TUI spawns it as a child process via `@ello/agent/server-entry`
- Model adapters live in `features/model/providers/ai-sdk/` wrapping Vercel AI SDK
- Telemetry is optional — controlled by `config.observability.langfuse` setting
