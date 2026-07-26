# @ello/tui

Client package for ello. Owns the CLI (Commander.js), Ink terminal UI, JSON-RPC client, and stdio/WebSocket/Unix transports. Never creates a model, executes a tool, writes server files, or decides permissions.

## STRUCTURE

```
src/
├── index.ts                 # Public barrel: client API, transports, thread/turn clients, TUI store
├── version.ts               # ELLO_TUI_VERSION
├── cli/                     # CLI layer
│   ├── main.ts              # Commander.js entry; binary `ello`
│   ├── render.ts            # Non-interactive renderer
│   ├── server-launcher.ts   # Spawns @ello/agent/server-entry as child process
│   ├── commands/            # CLI command handlers (run, app-server, catalog, management, workspace)
│   ├── shared/              # Shared CLI utilities (options resolution)
│   ├── slash-commands.ts    # In-TUI slash command definitions
│   └── types.ts             # CLI-specific types
├── client/                  # JSON-RPC client layer
│   ├── thread-client.ts     # High-level Thread API (start, submit, approve, read)
│   ├── turn-client.ts       # Turn lifecycle (events, items, completion)
│   ├── connection.ts        # connectClient() factory (local vs remote)
│   ├── local-server.ts      # Child-process server launcher
│   ├── remote-server.ts     # WebSocket/Unix remote connection
│   └── event-reducer.ts     # Event → state reducer (pure function)
├── api/                     # Low-level RPC primitives
│   ├── client.ts             # JsonRpcClient wrapper
│   ├── transport.ts          # Transport interface
│   ├── transports/           # stdio-child, websocket, async-byte-queue, jsonl-framer
│   ├── protocol-types.ts     # Re-exports from @ello/agent/protocol
│   ├── server-requests.ts    # Server Request handling (approval, user-input)
│   ├── request-errors.ts     # Error types
│   └── subscriptions.ts      # Notification subscription helpers
├── tui/                     # Ink terminal UI
│   ├── App.tsx              # Root component, event loop orchestrator
│   ├── index.ts             # renderTui() entry point
│   ├── ui/                  # Design tokens, typography, surfaces, glyphs
│   ├── component/           # React components (AppShell, Composer, LiveViewport, etc.)
│   ├── hooks/               # Custom hooks (use-composer-state, use-overlay, use-runtime-events, etc.)
│   ├── store/               # State management (timeline, event-reducer, composer, history, diff)
│   ├── commands/             # Slash command registry
│   ├── presenters/           # View logic (data → display format)
│   ├── settings/             # Settings types
│   ├── theme/               # Theme context, ThemeProvider, theme definitions
│   └── ...                  # thread-command-runner, model-selectors, completion, screen-utils
├── testing/                 # Shared test infrastructure
│   ├── memory-transport.ts  # In-memory transport for tests
│   └── protocol-fixtures.ts  # Protocol type factories (FileChange, Usage, ThreadSummary)
└── config/                  # Local UI config
    └── local-ui-config.ts
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| CLI entry point | `src/cli/main.ts` | Commander.js; binary `ello` |
| Add a CLI command | `src/cli/commands/` | Register in `main.ts` |
| TUI render entry | `src/tui/App.tsx` | Root Ink component; orchestrates event loop |
| Add a TUI component | `src/tui/component/` | PascalCase filenames (`.tsx`) |
| Add a custom hook | `src/tui/hooks/` | kebab-case filenames |
| State management | `src/tui/store/` | Timeline store, event-reducer, composer buffer |
| JSON-RPC protocol | `src/api/protocol-types.ts` | Re-exports from `@ello/agent/protocol` |
| Server connection | `src/client/connection.ts` | `connectClient()` — local (child process) or remote |
| In-TUI slash commands | `src/tui/slash-commands.ts` + `src/tui/commands/registry.ts` | Registered at TUI init |
| Design system | `src/tui/ui/` | tokens.ts, surfaces.ts, Typography.tsx, Layout.tsx |
| Theme switching | `src/tui/theme/` | ThemeProvider, theme definitions |

## CONVENTIONS

- **Import boundary**: Only `@ello/agent/protocol` — never `@ello/agent` root, `@ello/agent/server-entry`, or internal paths
- **Component files**: PascalCase (`.tsx`) — `LiveViewport.tsx`, not `live-viewport.tsx`
- **Non-component files**: kebab-case (`.ts`) — `event-reducer.ts`, `thread-client.ts`
- **State**: TUI uses event-reducer pattern — `event-reducer.ts` is a pure function mapping events to state diffs
- **Test files**: `*.test.ts` or `*.test.tsx` under `tests/<module>/`
- **Test helpers**: `tests/support/` for overlay fixtures; `src/testing/` for shared protocol factories

## ANTI-PATTERNS

- Do NOT import `@ello/agent` — only `@ello/agent/protocol`
- Do NOT import `@ello/agent/server-entry` — resolve it for child process spawn only
- Do NOT execute tools or create models in TUI — server owns all execution
- Do NOT add server-side deps (better-sqlite3, drizzle-orm, @ai-sdk) — `verify-dist.mjs` blocks contaminated builds
- Do NOT use cyclic imports (enforced by ESLint)

## UNIQUE STYLES

- **Two renderers**: TUI mode (`renderTui()` via Ink) and non-interactive mode (`render.ts` for `--no-tui` / `--json`)
- **Local server launcher**: `src/client/local-server.ts` spawns `@ello/agent/server-entry` as child process
- **ThreadHarness pattern** (tests): `createThreadHarness()` + `snapshot()` + `submitCommand()` for TUI integration tests
- **Overlay system**: `src/tui/hooks/use-overlay.ts` manages modal/panel overlay lifecycle
- **Composer buffer**: `src/tui/store/composer-buffer.ts` handles multi-line input editing

## COMMANDS

```bash
pnpm --filter @ello/tui build              # Build (atomic swap)
pnpm --filter @ello/tui test               # Vitest (tests/)
pnpm --filter @ello/tui typecheck          # tsc --noEmit (src + tests)
pnpm --filter @ello/tui lint               # ESLint src
pnpm --filter @ello/tui run ello --help    # Run CLI
pnpm --filter @ello/tui run ello --no-tui run "prompt"  # Non-interactive mode
```

## NOTES

- `bin.ello` points to `dist/cli/main.js` — installed globally via `pnpm add -g .`
- TUI uses `ink@6` + `react@19` — JSX via `react-jsx` transform
- Default local endpoint spawns `@ello/agent/server-entry` as child process; use `--remote ws://...` for long-running server
- `verify-dist.mjs` rejects builds containing better-sqlite3, drizzle-orm, or React in wrong places
- Test tsconfig includes `tests/**/*.ts(x)` with `noEmit`
