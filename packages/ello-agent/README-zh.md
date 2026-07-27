# @ello/agent

`@ello/agent` 是 ello 的 App Server。它拥有 provider 密钥、模型执行、工具、权限、存储以及 Thread/Turn/Item runtime；Client 只能通过 JSON-RPC 2.0 连接，不能 import Server 实现。

## 能力

- Thread、Turn、Item、管理 RPC 和 Server Request 的 JSON-RPC v1 schema
- `vscode-jsonrpc` connection runtime 与 Zod route/result 校验
- Fastify WebSocket/HTTP 宿主、鉴权、健康检查和优雅关闭
- stdio、WebSocket 和 Unix socket transport
- Server-owned 模型适配器、工具、权限、技能、记忆、工作区和持久化
- 支持断线恢复的审批与用户输入请求

## 启动 Server

```bash
pnpm --filter @ello/agent build
node packages/ello-agent/dist/main.js --listen stdio://
```

公开出口只包含 Server 生命周期和 `@ello/agent/protocol`。`@ello/agent/server-entry` 只由 `@ello/tui` 用来启动隔离的 Server 进程。

JSON-RPC 生命周期为 `initialize` → `initialized` → `thread/start` 或 `thread/resume` → `turn/start`。`vscode-jsonrpc` 负责通用 request/response 关联和 Cancellation；Ello 负责协议版本、capability、Zod schema、response-before-notification、有界背压和持久化 Server Request ID。

## Runtime 装配

`createApp()` 必须接收 `agentRuntime`，其中包含两个必选 factory：

- `createEnvironment(input)`：为一次 Agent run 创建 filesystem、shell 和 resource lifecycle。
- `createTracing(input)`：为一次 Agent run 创建 event recorder 和 close 操作。

产品入口使用 `features/environment/` 中的本地实现。需要为 Agent 提供其他执行环境的 package，可以通过稳定的 `@ello/agent/runtime` 子路径使用 `AgentRuntime`、`AgentEnvironment`、`AgentShell`、recorder 类型、`createLocalEnvironment()` 和 `listenEndpoint()`，不需要 import `src/**` 私有文件。

environment feature 的职责分为 factory、filesystem policy、shell、resource registry、路径规范化和 instruction。engine 只依赖 `AgentEnvironment`/`AgentShell` contract，不 import 产品 environment；`buildAgent()` 也只消费 composition root 显式传入的 runtime。

Runtime 实现遇到 workspace 不匹配、cwd 越界、shell 启动失败、recorder 写入失败或资源关闭失败时必须直接失败。缺少完整 event capture 或正常资源关闭的运行不能作为有效测评结果。

## Benchmark 接入

完整 benchmark runner 位于 `@ello/bench`；`@ello/agent` 只提供其需要的 runtime 和 App Server 边界，任务调度、Docker image、评分和报告不会进入产品 Agent。

每个 benchmark job 会向 Agent 注入：

- 只允许访问任务 workspace 的 host filesystem；
- 把 workspace cwd 映射到 `/app`、并在唯一任务 container 中执行命令的 `AgentShell`；
- 按 sequence 写入并脱敏的 EngineEvent JSONL recorder；
- 独立的 App Server state root 和 Unix socket。

runner 为每个 job 启动独立 App Server 子进程，使 `ELLO_HOME`、config、SQLite、session、artifact、recorder 和 provider 环境互不共享。普通 `ello --remote ... --json --no-tui run` 客户端仍从任务 workspace 创建 Thread；App Server root 只保存运行状态，不能作为 task cwd。

EngineEvent 是 model call 的权威证据。一个 model round 按 `modelCallId` 从 `model.started` 配对到 `model.completed` 或 `model.failed`；Thread/Turn notification 仍是客户端协议，不能用来补造缺失 provider usage。recorder 关闭时会写入 event/run/turn/model-call 数量和 JSONL SHA-256 marker。

从 workspace root 构建和检查：

```bash
pnpm --filter @ello/agent build
pnpm --filter @ello/tui build
pnpm --filter @ello/bench build
pnpm --filter @ello/bench bench doctor
pnpm --filter @ello/bench bench plan
```

运行命令、证据目录、verifier 和评分方法见 [`@ello/bench`](../ello-bench/README-zh.md)。
