# @ello/agent

`@ello/agent` is Ello's App Server. It owns provider credentials, model execution, tools, permissions, storage, and the Thread/Turn/Item runtime. Clients connect through JSON-RPC 2.0 and never import the server implementation.

## Features

- JSON-RPC v1 schemas for Thread, Turn, Item, management RPC, and Server Requests
- `vscode-jsonrpc` connection runtime with Zod route/result validation
- Fastify WebSocket/HTTP host with authentication, health checks, and graceful shutdown
- stdio, WebSocket, and Unix socket transports
- Server-owned model adapters, tools, permissions, skills, memory, workspace, and persistence
- Approval and user-input requests that can be resumed by a reconnecting client

## Start the server

```bash
pnpm --filter @ello/agent build
node packages/ello-agent/dist/main.js --listen stdio://
```

The public package export contains the server lifecycle and `@ello/agent/protocol`. The `@ello/agent/server-entry` subpath is used by `@ello/tui` to spawn an isolated process.

The JSON-RPC lifecycle is `initialize` → `initialized` → `thread/start` or `thread/resume` → `turn/start`. `vscode-jsonrpc` owns generic request/response correlation and cancellation; Ello owns protocol version, capabilities, Zod schemas, response-before-notification, bounded backpressure, and durable Server Request IDs.

## Runtime composition

`createApp()` requires an `agentRuntime` object. The runtime has two required factories:

- `createEnvironment(input)` creates the filesystem, shell, and resource lifecycle for one Agent run.
- `createTracing(input)` creates the run recorder and its close operation.

The executable server entry supplies the normal local filesystem, local shell, and tracing implementation. An embedding process can provide a job-scoped implementation through the stable `@ello/agent/runtime` subpath. That subpath exports the `AgentRuntime`, `AgentEnvironment`, `AgentShell`, and recorder types, `createLocalEnvironment()`, and `listenEndpoint()`.

This is the extension point used by the benchmark runner. It keeps the App Server, client protocol, and agent loop unchanged while a run receives a task workspace filesystem, a container-backed shell, and an append-only event recorder. The runner creates the App Server with an isolated state root, starts a Unix listener with `listenEndpoint()`, then connects the ordinary `ello --remote unix://... --json --no-tui run ...` client. The App Server root is state storage only; the CLI process working directory remains the task workspace.

Runtime implementations must fail when their workspace, shell, or recorder contract is invalid. A run is not publishable without a complete event capture and a clean resource shutdown.

## Benchmark integration

The executable benchmark workflow lives in `@ello/bench`; `@ello/agent` only provides the runtime and server boundaries it needs. This keeps evaluation scheduling, task images, scoring, and reports out of the product Agent.

For every benchmark job, the runner provides:

- a host workspace that is the only filesystem root visible to Agent file tools;
- an `AgentShell` that maps workspace cwd values to `/app` and executes commands in one assigned Docker container;
- an `AgentEventRecorder` that writes ordered, redacted EngineEvent JSONL;
- an isolated App Server state root and Unix socket.

The benchmark starts the App Server in a job-specific child process so each process receives its own `ELLO_HOME`, config, SQLite database, sessions, artifacts, recorder, and provider environment. The normal `ello --remote ... --json --no-tui run` client then creates the Thread from the task workspace. The App Server root is never used as the task cwd.

The EngineEvent recorder is the authoritative model-call evidence. A model round is paired by `modelCallId` from `model.started` to `model.completed` or `model.failed`; the public Thread/Turn notification stream remains a client protocol and is not used to invent missing provider usage. Recorder close writes a completion marker with counts and a SHA-256 checksum.

Build and inspect the benchmark from the workspace root:

```bash
pnpm --filter @ello/agent build
pnpm --filter @ello/tui build
pnpm --filter @ello/bench build
pnpm --filter @ello/bench bench doctor
pnpm --filter @ello/bench bench plan
```

Run and evidence details are documented in [`@ello/bench`](../ello-bench/README.md).
