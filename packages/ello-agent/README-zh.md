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
