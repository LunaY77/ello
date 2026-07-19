# @ello/agent

`@ello/agent` is Ello's App Server. It owns provider credentials, model execution, tools, permissions, storage, and the Thread/Turn/Item runtime. Clients connect through JSON-RPC 2.0 and never import the server implementation.

## Features

- JSON-RPC v1 schemas for Thread, Turn, Item, management RPC, and Server Requests
- stdio, WebSocket, and Unix socket transports
- Server-owned model adapters, tools, permissions, skills, memory, workspace, and persistence
- Approval and user-input requests that can be resumed by a reconnecting client

## Start the server

```bash
pnpm --filter @ello/agent build
node packages/ello-agent/dist/server/entry.js --listen stdio://
```

The public package export contains only the server lifecycle and `@ello/agent/protocol`. The `@ello/agent/server-entry` subpath is used by `@ello/tui` to spawn an isolated process.

The JSON-RPC lifecycle is `initialize` → `initialized` → `thread/start` or `thread/resume` → `turn/start`. Progress is delivered as typed notifications; approvals and user input are bidirectional Server Requests.
