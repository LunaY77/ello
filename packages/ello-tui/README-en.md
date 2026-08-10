# @ello/tui

<p align="center"><a href="../../README-en.md">Project home</a> · <a href="README.md">简体中文</a> · <strong>English</strong></p>

`@ello/tui` is Ello's Client package: the `ello` CLI, Ink terminal UI, headless renderer, typed JSON-RPC Client, and stdio/WebSocket/Unix transports.

It never creates models, executes Commands, reads provider credentials, or writes Server state directly. All business state comes from `@ello/agent` snapshots, notifications, and Server Requests.

## Why the Client is separate

- Thread, Turn, Command, Goal, and task state stay Server-owned and durable.
- Local child processes and remote endpoints use the same versioned protocol.
- Reconnect rebuilds the UI from a full snapshot before live events resume.
- TUI and headless JSON output share one typed Client.
- Zod validates request parameters, results, notifications, and Server Requests at the boundary.

## Connection modes

The default command starts `@ello/agent/server-entry` as an isolated child and connects over stdio. Remote mode skips the local Server:

```bash
ello --remote ws://127.0.0.1:4321
ello --remote unix:///tmp/ello.sock
```

A remote bearer token is read from the environment named by `--remote-auth-token-env`.

## Interactive TUI

```bash
pnpm --filter @ello/tui build
pnpm --filter @ello/tui run ello
```

The screen separates durable History, current Live execution, and the Bottom Dock. It renders streaming model text, Commands, approvals, steering input, token/cache state, and Subagent summaries. Thread switches and reconnects rebuild History from the Server snapshot rather than replaying stale UI events.

## Headless and management CLI

```bash
pnpm --filter @ello/tui run ello --no-tui run \
  "Find the failing tests, fix the root cause, and verify it"

pnpm --filter @ello/tui run ello --no-tui --json run \
  "Summarize this repository"
```

Management commands for models, sessions, config, skills, goals, memory, tasks, repositories, and workspaces still call typed Server methods; the CLI only parses input and renders output.

## Protocol correctness

The connection negotiates protocol version, transport, and Client capabilities through `initialize -> initialized`. `vscode-jsonrpc` owns generic correlation, cancellation, and cleanup. Ello adds result re-validation, capability checks, response-before-notification ordering, bounded queues, sequence-gap recovery, and durable interaction IDs.

Recovery order is deterministic:

```text
full snapshot -> pending Server Requests -> live notifications
```

## Validation

```bash
pnpm --filter @ello/tui test
pnpm --filter @ello/tui typecheck
pnpm --filter @ello/tui lint
pnpm --filter @ello/tui build
pnpm --filter @ello/tui verify-dist
```

See the [TUI guide](../../docs/tui/README.md), [input and commands](../../docs/tui/input-and-commands.md), [session recovery](../../docs/tui/sessions-modes-and-context.md), and [Client-Server architecture](../../docs/agent/client-server-architecture.md).
