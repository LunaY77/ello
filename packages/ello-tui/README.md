# @ello/tui

`@ello/tui` is the client-side package for Ello. It owns the CLI, Ink terminal UI, JSON-RPC client, and stdio/WebSocket/Unix transports. It never creates a model, executes a tool, writes server files, or decides permissions.

```bash
pnpm --filter @ello/tui build
pnpm --filter @ello/tui run ello --help
pnpm --filter @ello/tui run ello --no-tui run "Explain this repository"
```

The default local endpoint starts `@ello/agent/server-entry` as a child process and performs the `initialize` handshake before any thread request. Use `--remote ws://...` or `--remote unix://...` for a long-running server.
