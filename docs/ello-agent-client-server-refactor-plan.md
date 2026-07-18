# ello Client-Server Breaking Rewrite 实施计划

- 状态：Canonical / Proposed
- 日期：2026-07-18
- 适用范围：repos/ello/packages/ello-agent、repos/ello/packages/ello-coding-agent，以及新建的 repos/ello/packages/ello-tui
- 重构性质：一次性 breaking rewrite，不承诺旧包、旧协议、旧 session runtime 或旧 public API 的兼容
- 参考资料：docs/codex-appserver-api.md、references/codex/codex-rs/app-server、references/codex/codex-rs/app-server-client、references/codex/codex-rs/tui/src/app_server_session.rs

本文不是功能愿望清单，而是后续实现时使用的代码级计划。每个阶段都说明要改哪些边界、哪些模块成为唯一事实源、哪些旧入口必须删除，以及通过什么测试判断阶段完成。

## 1. 最终结论

这次重构同时解决两个问题：

1. ello-agent 和 ello-coding-agent 的产品边界消失：所有模型运行、coding-agent 产品能力、持久化和 App Server 都归入一个 @ello/agent。
2. ello-agent 与 CLI/TUI 完全进程隔离：@ello/agent 只作为 Server 进程运行；@ello/tui 只作为 JSON-RPC Client、CLI 和 Ink TUI 运行。

最终包结构：

```text
packages/
├── ello-agent/                 # @ello/agent：唯一 Server
│   └── src/                     # Server runtime and wire schema
└── ello-tui/                   # @ello/tui：CLI + TUI + Client
    └── ello                    # 用户入口
```

最终执行链只有一条：

```text
ello-tui CLI/TUI
        │  JSON-RPC 2.0
        ▼
ello-agent App Server 进程
        │  Thread / Turn / Item runtime
        ▼
agent execution + Server-owned capabilities
        │
        ▼
provider / filesystem / shell / storage
```

### 1.1 明确采用的决策

- @ello/agent 吸收当前 @ello/coding-agent 的 Server-owned 代码，并删除原来的 SDK 形态。
- 新建 @ello/tui，由它拥有 CLI、Ink 组件、TUI reducer 和网络/stdio Client。
- 默认本地 TUI 通过 stdio:// 启动一个独立的 ello-agent 子进程；不允许直接 import Server runtime。
- --remote ws://、--remote wss:// 和 --remote unix:// 连接长期运行的 Server。
- 不保留 in-process 运行路径，不保留旧 CodingSession adapter，不保留旧 envelope 协议 fallback。
- 对外资源模型改成不可变的 Thread -> Turn -> Item。
- 审批和用户输入使用 JSON-RPC Server Request；不再使用 approval.respond 事件式命令。
- Server 是配置、权限、provider key、工作区路径、工具执行和持久化的唯一所有者。
- 客户端只保存 UI 状态、草稿、连接信息和经过 Server 脱敏后的展示数据。
- Ello 应用协议以稳定 v1 开始；JSON-RPC 外层仍使用标准 `jsonrpc: "2.0"`。未实现的方法返回结构化 methodNotFound，不返回空占位。
- 公共 CLI 全部属于 @ello/tui；@ello/agent 只提供给 @ello/tui spawn 的非公共 server-entry，不包含 CLI command tree。
- 旧 session JSONL 不在正常 Server 启动路径中自动导入。需要保留数据时，另写一次性离线 importer。

### 1.2 有意不照搬 Codex 的地方

Codex 的 app-server 文档和代码提供了正确的职责拆分：initialize 握手、Thread/Turn/Item、双向 Server Request、连接级状态、出站队列和线程监听器。Ello 会采用这些原则，但做出几个有意的差异：

- Codex 目前同时支持 in-process client；Ello 的目标是强制进程边界，因此不会实现 Embedded 或 InProcess 分支。
- Codex wire 上省略 jsonrpc 字段；Ello 保留完整的 jsonrpc: '2.0'，让标准 JSON-RPC 工具能够直接验证消息。
- Codex API 很大；Ello 只实现当前产品真实需要的 thread、turn、tools、workspace、memory、goal、plan 和 config 方法。
- Codex 仍有部分 legacy/experimental 方法；Ello 的稳定协议从新 schema 开始，不向新客户端暴露旧名称。
- Ello 的本地默认启动方式是由 ello 拥有一个 stdio 子进程，避免隐式复用一个不受当前命令控制的全局 Server。

## 2. 当前代码审计

### 2.1 当前包的实际职责

| 位置                                                     | 当前职责                                              | 观察到的事实                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| packages/ello-agent/src/core                             | provider 无关模型循环、stream、tool scheduler、resume | 现在仍是 SDK 形态，createAgent() 直接暴露给产品层                                     |
| packages/ello-agent/src/public                           | SDK 类型和工厂                                        | public/agent.ts 公开 run/stream/resume/close                                          |
| packages/ello-agent/src/adapters                         | AI SDK provider adapter                               | 需要继续留在 Server，但不再是独立 SDK 能力                                            |
| packages/ello-coding-agent/src/runtime/coding-session.ts | 产品 runtime 总协调器                                 | 约 2,808 行，同时装配 agent、权限、工具、memory、goal、plan、storage 和事件           |
| packages/ello-coding-agent/src/runtime/intents.ts        | TUI/CLI 事件联合类型                                  | 直接把 AgentStreamEvent 暴露给前端                                                    |
| packages/ello-coding-agent/src/session                   | JSONL session tree、leaf、branch、compaction          | 当前 schema version 为 3，资源身份可在 CodingSession 对象上切换                       |
| packages/ello-coding-agent/src/storage                   | SQLite、artifact、workspace、usage、task 数据         | createCodingSession() 每次创建并关闭 CodingStorage                                    |
| packages/ello-coding-agent/src/cli                       | Commander 命令树                                      | 直接 import createCodingSession、config、storage、provider 和 workspace               |
| packages/ello-coding-agent/src/tui                       | Ink UI                                                | App.tsx 直接 import config、provider、filesystem、session 和多个 Server-owned service |
| packages/ello-coding-agent/src/tools                     | coding tools、shell、filesystem、patch                | 工具执行发生在当前 CLI/TUI 进程                                                       |
| packages/ello-coding-agent/src/agents                    | primary/subagent/background agent                     | 依赖当前进程内的 CodingSession 和 storage                                             |

规模上，ello-coding-agent/src 约 43k 行；最大的耦合点是 coding-session.ts、session/repository.ts、tui/App.tsx 和 workspace CLI。这个规模不适合只加一层 RPC facade，必须先拆分所有权。

### 2.2 当前执行流程

```text
ello-coding-agent CLI
  ├─ resolveConfig()
  ├─ createCodingSession()
  │   ├─ createCodingStorage()
  │   ├─ load RulesStore
  │   ├─ create AgentRegistry
  │   ├─ create MemoryJobCoordinator
  │   ├─ create CodingSessionImpl
  │   └─ createAgent()  ← @ello/agent
  ├─ subscribe(CodingSessionEvent)
  └─ launchTui(CodingSession)
       └─ App.tsx 直接调用 session 方法
```

这条链的问题不是调用方向难看，而是 Server 生命周期等于 UI 生命周期：

- TUI 关闭会关闭 storage、memory worker、tracing 和 Agent；
- 两个 CLI 进程可以各自加载相同 session，彼此不知道对方正在写；
- approval 是同一个进程里的 Map，不可能在客户端断开后由另一个客户端接管；
- sessionId 在同一个 CodingSessionImpl 上被 newSession()、resumeSession() 和 fork() 修改；
- AgentStreamEvent 的内部 run/turn 命名与 Codex 风格的外层 Turn 混淆；
- runOnce()、TUI 和 CLI management commands 各自拥有一部分业务调用路径。

### 2.3 必须拆掉的耦合

以下 import 关系在目标代码中必须不存在：

- ello-tui 从 @ello/agent 根路径 import createAgent、environment、provider、storage 或 permission 实现；
- TUI 组件直接 import CodingAgentConfig、ProviderRegistry、RulesStore、JsonlSessionStore 或 createCodingTools；
- CLI command module 直接创建 CodingStorage、TaskService、MemoryRepository 或 JsonlSessionRepository；
- Server-owned config 写操作在客户端直接修改 ~/.ello/config.yaml 或项目 .ello/config.yaml；
- TUI 的 @file completion、shell escape、plan artifact 读取绕过 Server；
- CodingSessionEvent 作为跨进程协议类型；
- @ello/agent/internal 或任何 Server 私有路径出现在 Client bundle。

## 3. 架构不变量

这些规则不是建议，而是实现和 code review 的验收条件。

### 3.1 所有权

- App Server 进程拥有 provider、API key、环境变量、filesystem、shell、workspace policy、storage、memory worker、background job 和 telemetry。
- Client 进程拥有 terminal、Ink render、键盘输入、UI reducer、局部草稿和连接。
- Client 不构造模型、不执行工具、不判定权限、不修改 Server 数据文件。
- Server 不 import React、Ink、Commander 的 TUI command module 或终端控制码。

### 3.2 单一执行路径

- 任何用户输入都通过 turn/start 或 turn/steer 到达 Server。
- 任何审批都通过 Server Request response 到达 Server。
- 任何 Server event 都从同一个 projection/event bus 产生；不维护一套给 TUI 的平行 event mapping。
- 本地 stdio、Unix socket、WebSocket 只替换 transport，不替换业务 handler。
- 不提供 createCodingSession()、createAgent() 作为生产 public API。

### 3.3 身份和并发

- threadId、turnId、itemId 创建后不可变。
- 一个 thread 同时只能有一个 active turn。
- 同一个 thread 的 mutation FIFO；不同 thread 可以并行。
- 一个 connection 的 request id 可以与其他 connection 重复；Server request id 必须全局唯一。
- active turn、pending approval 或 pending user input 存在时，thread 不能自动 unload。

### 3.4 Fail fast

- 未初始化、重复初始化、未知 method、非法 params、未知 id、过期 turn、损坏记录和越界路径都立即返回结构化错误。
- 不用英文 error message 做分支判断。
- 不静默跳过损坏 JSONL、不退回旧 schema、不自动切换到 in-process。
- 不用空数组、空对象或 null 假装方法已实现。

### 3.5 恢复主源

- Server restart 和 Client reconnect 都通过 thread snapshot/read/resume 恢复。
- 内存 event queue 只做低延迟传输，不是历史主源。
- 不把客户端 cursor/replay buffer 作为唯一恢复机制。
- item/completed 是 item 最终状态；delta 只用于临时渲染。

## 4. 目标包和目录

### 4.1 @ello/agent：唯一 Server 包

```text
packages/ello-agent/
├── package.json
├── tsconfig.json
├── scripts/
│   ├── build.mjs
│   └── verify-dist.mjs
└── src/
    ├── server/
    │   ├── entry.ts
    │   ├── bootstrap.ts
    │   ├── server.ts
    │   ├── lifecycle.ts
    │   ├── connection/
    │   │   ├── connection-state.ts
    │   │   ├── connection-registry.ts
    │   │   ├── rpc-gate.ts
    │   │   ├── subscriptions.ts
    │   │   └── pending-server-requests.ts
    │   ├── rpc/
    │   │   ├── processor.ts
    │   │   ├── router.ts
    │   │   ├── outgoing-router.ts
    │   │   └── serialization-queues.ts
    │   ├── transport/
    │   │   ├── transport.ts
    │   │   ├── stdio.ts
    │   │   ├── websocket.ts
    │   │   ├── unix-socket.ts
    │   │   ├── auth.ts
    │   │   └── health.ts
    │   ├── methods/
    │   │   ├── initialize.ts
    │   │   ├── thread.ts
    │   │   ├── turn.ts
    │   │   ├── history.ts
    │   │   ├── config.ts
    │   │   ├── catalog.ts
    │   │   ├── files.ts
    │   │   ├── tasks.ts
    │   │   ├── workspace.ts
    │   │   ├── goal.ts
    │   │   ├── plan.ts
    │   │   └── memory.ts
    │   ├── runtime/
    │   │   ├── thread-manager.ts
    │   │   ├── thread-runtime.ts
    │   │   ├── thread-recovery.ts
    │   │   ├── turn-controller.ts
    │   │   ├── steering-queue.ts
    │   │   └── subscription-hub.ts
    │   └── interaction/
    │       ├── interaction-broker.ts
    │       ├── pending-request-store.ts
    │       └── request-lease.ts
    ├── protocol/
    │   ├── json-rpc.ts
    │   ├── errors.ts
    │   ├── version.ts
    │   └── v1/
    │       ├── common.ts
    │       ├── resources.ts
    │       ├── requests.ts
    │       ├── responses.ts
    │       ├── notifications.ts
    │       ├── server-requests.ts
    │       └── index.ts
    ├── domain/
    │   ├── ids.ts
    │   ├── thread/
    │   │   ├── thread.ts
    │   │   ├── status.ts
    │   │   └── settings.ts
    │   ├── turn/
    │   │   ├── turn.ts
    │   │   ├── status.ts
    │   │   └── lifecycle.ts
    │   ├── item/
    │   │   ├── item.ts
    │   │   ├── kinds.ts
    │   │   └── lifecycle.ts
    │   ├── events/
    │   │   ├── domain-event.ts
    │   │   └── sequence.ts
    │   ├── projection/
    │   │   ├── thread-snapshot.ts
    │   │   └── timeline.ts
    │   └── ports/
    │       ├── repositories.ts
    │       ├── event-log.ts
    │       ├── filesystem.ts
    │       ├── command-runner.ts
    │       └── interaction.ts
    ├── agent/
    │   ├── engine/
    │   ├── execution/
    │   ├── context/
    │   ├── tools/
    │   ├── providers/
    │   ├── permissions/
    │   ├── skills/
    │   ├── memory/
    │   ├── plans/
    │   ├── goals/
    │   ├── subagents/
    │   ├── environment/
    │   └── composition/
    ├── storage/
    │   ├── database/
    │   ├── migrations/
    │   ├── repositories/
    │   ├── threads/
    │   ├── transcripts/
    │   ├── artifacts/
    │   └── usage/
    ├── config/
    │   ├── schema.ts
    │   ├── loader.ts
    │   ├── paths.ts
    │   ├── initializer.ts
    │   └── templates/
    ├── workspace/
    │   ├── service.ts
    │   ├── git.ts
    │   ├── paths.ts
    │   ├── repo-store.ts
    │   ├── workspace-store.ts
    │   └── tmux.ts
    ├── observability/
    │   ├── logger.ts
    │   ├── observer.ts
    │   ├── recorder.ts
    │   ├── tracing.ts
    │   └── content-policy.ts
    └── index.ts
```

`ello-agent` 内部不再有公共 CLI。`server/entry.ts` 只负责读取由 `ello-tui` 传入的结构化启动参数并启动 `AgentServer`；它不是 Commander command tree，也不提供用户直接调用的 `ello-agent --listen` 产品命令。

各顶层目录的边界固定如下：

- `server/` 负责进程生命周期、连接、transport、RPC dispatch、method handler、Thread/Turn 协调和 approval/user-input broker，不实现模型循环。
- `protocol/` 负责 JSON-RPC 2.0 envelope 和 Ello application protocol v1 schema；不依赖 `server`、`storage` 或 `agent` 实现。
- `domain/` 负责纯粹的 Thread/Turn/Item、领域事件、snapshot projection 和 ports；不依赖 AI SDK、React、Ink、Commander、SQLite 或网络。
- `agent/` 是原 `ello-agent` engine 加上原 `ello-coding-agent` 的 coding 能力。`engine/` 是 provider-agnostic model loop，`execution/` 负责把一个 Turn 交给 engine，其他目录分别承载 tools、providers、permissions、skills、memory、plans、goals、subagents 和 execution environment。
- `storage/` 只实现持久化 ports，保存 event log、snapshot、transcript、artifact、usage 和 SQLite repositories，不拥有 Thread/Turn 的业务状态机。
- `config/` 只负责配置加载、校验、路径和模板；`workspace/` 负责 workspace/repository/Git/path/tmux 业务；`observability/` 负责日志、trace、usage 和 recorder。

`domain/ports` 是跨顶层模块的依赖反转边界。`storage`、`workspace`、`agent` 不通过彼此的具体实现互相调用；`server/bootstrap.ts` 负责把具体实现组装起来。

依赖方向固定为：

```text
protocol  ───────────────────────────┐
domain    ───────────────────────────┼──> server
agent  ───────> domain                │
storage ──────> domain                │
workspace ────> domain                │
config ──────────────────────────────┤
observability ───────────────────────┘
```

`server` 是唯一允许依赖所有顶层目录的组装层。`agent` 不 import `server`、`protocol` 或 `storage`；`storage` 不 import `agent`；`workspace` 只通过 `domain/ports` 使用文件和命令执行契约。任何跨域具体实现依赖都必须移动到 `server/bootstrap.ts`。

### 4.2 @ello/tui：唯一 Client/UI 包

```text
packages/ello-tui/
├── package.json
├── tsconfig.json
├── scripts/
│   └── build.mjs
└── src/
    ├── cli/
    │   ├── main.ts
    │   ├── types.ts
    │   ├── render.ts
    │   ├── server-launcher.ts
    │   └── commands/
    │       ├── app-server.ts
    │       ├── run.ts
    │       ├── resume.ts
    │       ├── thread.ts
    │       ├── config.ts
    │       ├── model.ts
    │       ├── skills.ts
    │       ├── tasks.ts
    │       ├── goal.ts
    │       └── workspace.ts
    ├── api/
    │   ├── client.ts
    │   ├── connection.ts
    │   ├── transport.ts
    │   ├── stdio-transport.ts
    │   ├── websocket-transport.ts
    │   ├── unix-transport.ts
    │   ├── request-errors.ts
    │   ├── server-requests.ts
    │   ├── subscriptions.ts
    │   └── protocol-types.ts
    ├── client/
    │   ├── local-server.ts
    │   ├── remote-server.ts
    │   ├── thread-client.ts
    │   ├── turn-client.ts
    │   ├── client-events.ts
    │   └── client-capabilities.ts
    ├── tui/
    │   ├── App.tsx
    │   ├── index.ts
    │   ├── hooks/
    │   ├── components/
    │   ├── commands/
    │   ├── overlays/
    │   ├── presenters/
    │   ├── store/
    │   │   ├── event-reducer.ts
    │   │   ├── timeline-store.ts
    │   │   ├── connection-store.ts
    │   │   └── local-ui-store.ts
    │   ├── theme/
    │   └── ui/
    ├── config/
    │   ├── local-ui-config.ts
    │   └── environment.ts
    ├── testing/
    └── utils/
```

### 4.3 包依赖和 exports

@ello/agent 的 package exports 只允许以下边界：

```json
{
  ".": "./dist/index.js",
  "./protocol": "./dist/protocol/v1/index.js",
  "./server-entry": "./dist/server/entry.js",
  "./package.json": "./package.json"
}
```

根出口只暴露 Server 启动所需的类型和 protocol schema；engine、tool、storage、provider 的实现全部是 private module。不得再导出 createAgent、createLocalEnvironment、defineTool 或 src/internal。`index.ts` 不负责启动进程，进程入口只通过 `./server-entry` 子路径解析。

@ello/tui 只允许：

- 类型和 zod schema 从 @ello/agent/protocol 导入；
- server-launcher.ts 只用 `import.meta.resolve`/`require.resolve` 解析 @ello/agent/server-entry 的文件路径，再把路径交给 child process；不得 import 或执行 Server module；
- 不 import @ello/agent 根出口中的 Server implementation。

ESLint 增加 no-restricted-imports：`ello-tui` 只能从 `@ello/agent/protocol` 读取协议类型；`src/cli/server-launcher.ts` 只能解析而不能 import `@ello/agent/server-entry`。CI 扫描 Client 构建产物，确认没有 `@ello/agent/internal` 或 Server implementation。

## 5. Server 内部架构

### 5.1 进程级 AgentServer

AgentServer 是整个 Server 进程的唯一生命周期所有者，负责：

- 加载和校验 AgentServerConfig；
- 初始化一个 CodingStorage、数据库连接、artifact store 和 thread catalog；
- 初始化 provider/model catalog、skills watcher、memory worker、observability；
- 创建 ThreadManager；
- 创建 ConnectionRegistry 和 OutgoingRouter；
- 启动一个或多个 transport；
- 处理 SIGINT、SIGTERM、stdin EOF 和显式 shutdown。

建议接口：

```ts
export interface AgentServer {
  readonly protocolVersion: number;
  readonly state: "starting" | "ready" | "stopping" | "stopped";
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
  acceptTransport(transport: AppServerTransport): Promise<void>;
}
```

关闭顺序必须固定：

1. 停止 accept 新连接；
2. 把 Server state 改成 stopping，拒绝新的 mutation；
3. 关闭每个 connection 的 RPC gate，等待已开始 request 到达终态；
4. 对 active turn 发送 abort，并等待持久化 turn/completed 或 turn/interrupted；
5. 关闭 thread runtime、background subagent、memory job 和 tracing；
6. flush thread log、artifact metadata 和 SQLite transaction；
7. 关闭数据库；
8. 关闭 transport writer 和 Unix socket。

任何一步失败都输出结构化 stderr 日志并以非零退出码结束；不能继续以部分可用状态运行。

### 5.2 不可变 Thread runtime

`ThreadRuntime` 替代当前可变身份的 `CodingSessionImpl`。`domain/thread` 保存纯领域状态，`server/runtime` 保存进程内 runtime；runtime 的构造参数中固定 threadId，生命周期内不得修改：

```ts
export interface ThreadRuntime {
  readonly id: string;
  readonly rootId: string;
  readonly cwd: string;
  readonly status: ThreadStatus;
  snapshot(): Promise<ThreadSnapshot>;
  startTurn(input: TurnInput, options: TurnOptions): Promise<TurnAccepted>;
  steerTurn(turnId: string, input: UserInput): Promise<void>;
  interruptTurn(turnId: string, reason: string): Promise<void>;
  resolveServerRequest(requestId: string, result: unknown): Promise<void>;
  rejectServerRequest(requestId: string, error: AppServerError): Promise<void>;
  close(): Promise<void>;
}
```

必须从原 CodingSession 删除以下身份切换方法：

- newSession()；
- resumeSession()；
- 在原对象上修改 sessionId 的 fork()；
- 把 clear() 解释成新建 session 的 UI 语义；
- listSessions()、exportSession() 等跨 thread 查询。

这些能力变成 ThreadManager 或独立 RPC service：

| 旧能力            | 新归属                                                |
| ----------------- | ----------------------------------------------------- |
| newSession()      | thread/start                                          |
| resumeSession(id) | thread/resume                                         |
| fork()            | thread/fork，返回新的 ThreadRuntime                   |
| clear()           | Client 选择 thread/start，不修改旧 thread             |
| listSessions()    | thread/list                                           |
| exportSession()   | thread/export                                         |
| checkout()        | 第一版改为 thread/fork 的 lastTurnId；不修改原 thread |
| rewind()          | Client 先 fork 到目标 turn，再把输入回填到 composer   |

### 5.3 ThreadManager

ThreadManager 是 process-scoped registry：

```ts
interface ThreadEntry {
  readonly thread: ThreadRuntime;
  readonly subscribers: Set<string>;
  readonly pendingRequests: Map<string, PendingServerRequest>;
  unloadTimer?: NodeJS.Timeout;
}

interface ThreadManager {
  start(params: ThreadStartParams): Promise<ThreadSnapshot>;
  resume(
    connectionId: string,
    params: ThreadResumeParams,
  ): Promise<ThreadSnapshot>;
  read(params: ThreadReadParams): Promise<ThreadSnapshot>;
  fork(params: ThreadForkParams): Promise<ThreadSnapshot>;
  list(params: ThreadListParams): Promise<ThreadListResponse>;
  unsubscribe(connectionId: string, threadId: string): Promise<void>;
}
```

规则：

- thread/read 只从 persistence 读取，不加载 model、skills、memory 或 shell。
- thread/start 先写 thread.created，再创建 runtime，最后原子地把 connection 订阅到新 thread。
- thread/resume 在同一 thread lock 中完成 snapshot、订阅和 pending request replay，避免 snapshot/live gap。
- 无 subscriber、无 active turn、无 pending request 时才开始 unload grace period。
- thread/fork 创建新的文件、SQLite index row 和 runtime；原 thread 保持只读历史。
- archive/delete 先从 registry 卸载，再操作持久化文件。

### 5.4 TurnController

外层 Turn 表示一次用户提交，不再等同于 @ello/agent 内部 model loop 的 turnIndex。

TurnController 负责：

1. 校验 thread 当前没有 active turn；
2. 生成不可变 turnId；
3. 写入 turn.started 和 user message item；
4. 在 detached task 中启动 Agent stream；
5. 把内部事件交给 projection；
6. 处理 steering、approval、user input 和 abort；
7. 写入 turn.completed、turn.interrupted 或 turn.failed。

内部 model loop 的术语统一改为 step 或 modelCall：

| 当前名称         | Server 内部新名称   | Wire 名称                         |
| ---------------- | ------------------- | --------------------------------- |
| runId            | turnExecutionId     | turnId                            |
| turnIndex        | stepIndex           | 不直接暴露                        |
| AgentStream      | EngineStream        | 不暴露                            |
| AgentRunResult   | TurnExecutionResult | turn/completed 中的 summary       |
| AgentStreamEvent | EngineEvent         | projection 后的 notification/item |

### 5.5 Agent composition 和模块依赖

当前 buildAgent() 中的装配逻辑必须拆开，避免再生成一个新的 2,800 行中心类：

| 新模块                                   | 从当前代码提取                                             |
| ---------------------------------------- | ---------------------------------------------------------- |
| agent/composition/agent-factory.ts       | model、instructions、transcript、compaction、observer 装配 |
| agent/composition/environment-factory.ts | allowed roots、RulesStore、realpath 校验、shell            |
| agent/composition/tool-factory.ts        | coding tools、goal、memory、plan、delegate、skill tools    |
| server/runtime/turn-controller.ts        | active turn、steering、abort、最终状态                     |
| server/interaction/interaction-broker.ts | approval、deferred tool、user input resume                 |
| domain/projection/item-projector.ts      | EngineEvent 到 domain item                                 |
| agent/context/\*                         | prompt sections、compaction、tool result budget            |
| agent/subagents/\*                       | primary/subagent/background jobs                           |
| agent/plans/\*                           | plan artifact、hash、accept/reject 状态机                  |

每个模块只接受显式依赖对象，不从 process.env、全局 singleton 或 Client 读取隐式状态。

### 5.6 Event pipeline

所有 Server notification 经过同一条 pipeline：

```text
EngineEvent
  -> DomainEventProjector
  -> ThreadEventStore.append(seq)
  -> ThreadSnapshotProjector.apply()
  -> SubscriptionHub.publish()
  -> Transport OutgoingQueue
```

要求：

- 先 append，再 publish；publish 失败不会让持久化事实消失；
- 每个 thread 的 seq 单调递增；
- item/completed 和 turn/completed 写入并 flush 后才发布；
- delta 允许按固定大小合并，但不得重排；
- Client 收到 seq gap 时标记 connection stale，并重新 thread/resume，不自行猜测缺失状态。

## 6. JSON-RPC 2.0 与 Ello Protocol v1

### 6.1 Wire 基础结构

Ello 使用完整 JSON-RPC 2.0 消息：

```ts
type RequestId = string | number;

interface RpcRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params: Record<string, unknown>;
}

interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: RequestId;
  result?: unknown;
  error?: RpcError;
}

interface RpcError {
  code: number;
  message: string;
  data?: {
    type: AppServerErrorType;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}
```

约束：

- 所有字段使用 camelCase；
- params 总是 object，空参数使用 {}；
- unknown field 由 zod .strict() 拒绝；
- request/response id 只做关联，不携带 thread 语义；
- thread/turn/item id 都是 opaque string；
- notification 没有 id；
- Server Request 与 Client Request 使用完全相同的 JSON-RPC request/response shape；
- stdio transport 一行一条 JSON，日志只写 stderr；
- 单行超过 8 MiB 直接返回 parse/invalid request 并关闭连接。

### 6.2 初始化握手

`protocol/version.ts` 导出唯一的 `ELLO_PROTOCOL_VERSION = 1`，`protocol/v1` 中的所有 schema 都引用这个常量。这里的 `1` 是 Ello application protocol 版本，不是 JSON-RPC 版本；JSON-RPC envelope 继续固定为 `jsonrpc: "2.0"`。

连接状态是 connection-local：

```text
transport auth
      ↓
client -> initialize(id=1, clientInfo, capabilities)
server -> initialize response
client -> initialized notification
server -> startup warnings/ready notifications
```

任何非 initialize request 在握手完成前都返回 notInitialized。重复 initialize 返回 alreadyInitialized。客户端在收到 initialize response 前不得发送 initialized 以外的业务请求。

建议参数：

```ts
interface InitializeParams {
  clientInfo: {
    name: string;
    title: string;
    version: string;
  };
  protocolVersion: 1;
  capabilities: {
    experimentalApi: boolean;
    supportsServerRequests: boolean;
    supportsUserInput: boolean;
    optOutNotificationMethods: string[];
    platform: "terminal" | "desktop" | "mobile" | "automation";
  };
}

interface InitializeResult {
  protocolVersion: 1;
  serverInfo: {
    name: "ello-agent";
    version: string;
  };
  serverCapabilities: {
    transports: string[];
    methods: string[];
    notifications: string[];
    serverRequests: string[];
  };
}
```

协议版本不匹配直接关闭，不自动协商到旧版本。experimental method 必须同时满足 Server 支持和 Client experimentalApi: true。

### 6.3 稳定 request 方法

第一版稳定 API 只覆盖当前 ello 产品已有能力：

| 资源      | method               | 作用                                  | 是否加载 thread runtime |
| --------- | -------------------- | ------------------------------------- | ----------------------- |
| Server    | server/read          | 返回版本、健康状态、能力              | 否                      |
| Server    | server/shutdown      | 关闭由当前 stdio client 拥有的 Server | 否                      |
| Thread    | thread/start         | 创建 thread、写 header、可选自动订阅  | 是                      |
| Thread    | thread/resume        | 加载 thread、原子订阅、返回 snapshot  | 是                      |
| Thread    | thread/read          | 只读持久化摘要/历史                   | 否                      |
| Thread    | thread/list          | 分页列出 thread summary               | 否                      |
| Thread    | thread/loaded/list   | 列出内存中 thread                     | 否                      |
| Thread    | thread/fork          | 从已有 turn 创建新 thread             | 是                      |
| Thread    | thread/unsubscribe   | 移除当前 connection 订阅              | 否                      |
| Thread    | thread/archive       | 归档 thread 及索引                    | 否                      |
| Thread    | thread/unarchive     | 恢复归档 thread                       | 否                      |
| Thread    | thread/delete        | 删除 thread、artifact 引用和索引      | 否                      |
| Thread    | thread/turns/list    | 分页读取 turn summary                 | 否                      |
| Thread    | thread/items/list    | 分页读取 item                         | 否                      |
| Thread    | thread/export        | 返回导出内容或 artifact handle        | 否                      |
| Thread    | thread/compact/start | 启动异步 compaction                   | 是                      |
| Thread    | thread/shellCommand  | 执行显式用户 shell command            | 是                      |
| Turn      | turn/start           | 接受 prompt 并异步启动 turn           | 是                      |
| Turn      | turn/steer           | 向 active turn 追加输入               | 是                      |
| Turn      | turn/interrupt       | 中断 active turn                      | 是                      |
| Goal      | thread/goal/get      | 读取 goal                             | 否/是                   |
| Goal      | thread/goal/set      | 创建或更新 goal                       | 是                      |
| Goal      | thread/goal/clear    | 清除 goal                             | 是                      |
| Plan      | thread/plan/read     | 读取当前 plan preview                 | 否                      |
| Plan      | thread/plan/preview  | 校验 hash 并返回 preview              | 是                      |
| Config    | config/read          | 读取 merged/source config             | 否                      |
| Config    | config/write         | 写 global/project config              | 否                      |
| Config    | config/init          | 初始化默认 config/assets              | 否                      |
| Config    | config/sources       | 返回 config source 列表               | 否                      |
| Model     | model/list           | 列出 provider/model catalog           | 否                      |
| Provider  | provider/list        | 列出 provider 和 doctor 状态          | 否                      |
| Agent     | agent/list           | 列出 primary/subagent                 | 否/是                   |
| Tool      | tool/list            | 列出当前可用工具及风险摘要            | 否/是                   |
| Skill     | skills/list          | 列出 skills                           | 否/是                   |
| Skill     | skills/reload        | 重新扫描 skills                       | 是                      |
| Memory    | memory/status        | 返回 memory 状态                      | 否/是                   |
| Memory    | memory/reload        | 刷新 memory index                     | 是                      |
| Memory    | memory/dream/start   | 启动 dream job                        | 是                      |
| Task      | task/list            | 列出 board tasks                      | 否                      |
| Task      | task/get             | 读取 task                             | 否                      |
| Task      | task/create          | 创建 task                             | 否                      |
| Task      | task/update          | 修改 task                             | 否                      |
| Task      | task/delete          | 删除 task                             | 否                      |
| Task      | task/claim           | claim task                            | 否                      |
| Task      | task/reset           | reset board                           | 否                      |
| Files     | fs/readFile          | 读取 Server workspace 文件            | 否                      |
| Files     | fs/readDirectory     | 读取目录                              | 否                      |
| Files     | fs/getMetadata       | 读取 metadata                         | 否                      |
| Files     | fs/search            | TUI completion/search                 | 否                      |
| Files     | fs/watch             | 注册 Server-side watch                | 否                      |
| Files     | fs/unwatch           | 移除 watch                            | 否                      |
| Workspace | repo/\*              | mirror/remote/fetch 操作              | 否                      |
| Workspace | workspace/\*         | workspace 生命周期和状态              | 否                      |

repo/_ 和 workspace/_ 不是把当前 Commander handler 原样塞进一个巨大 method；每个子命令都要有独立 zod params、response 和 repository transaction。

### 6.4 Turn 参数和响应

```ts
interface TurnStartParams {
  threadId: string;
  input: readonly UserInput[];
  model?: string;
  profile?: string;
  mode?: SessionMode;
  metadata?: Record<string, string>;
}

interface TurnStartResult {
  turn: {
    id: string;
    threadId: string;
    status: "inProgress";
    items: readonly [];
  };
}

interface TurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  input: readonly UserInput[];
}
```

turn/start 只在 turn 已经落盘并交给后台 runner 后返回。它不等待模型结束。turn/steer 必须匹配 expectedTurnId；没有 active turn 或 id 不匹配直接返回 turnMismatch。

turn/interrupt 是幂等的：第一次请求触发 abort，后续相同 turn 的请求返回当前终态，不再次创建 run。

### 6.5 Notification

第一版 notification：

| method                            | 载荷                          | 语义                  |
| --------------------------------- | ----------------------------- | --------------------- |
| thread/started                    | thread summary                | 新 thread 已持久化    |
| thread/status/changed             | threadId、status、activeFlags | runtime 状态变化      |
| thread/closed                     | threadId、reason              | runtime unload        |
| thread/name/updated               | threadId、name                | title 更新            |
| thread/goal/updated               | threadId、goal                | goal 变化             |
| thread/goal/cleared               | threadId、goalId              | goal 清除             |
| thread/tokenUsage/updated         | threadId、usage               | usage 聚合            |
| thread/archived                   | threadId                      | archive 完成          |
| thread/unarchived                 | thread summary                | unarchive 完成        |
| thread/deleted                    | threadId                      | delete 完成           |
| turn/started                      | threadId、turn                | turn 开始             |
| turn/completed                    | threadId、turn                | 最终 turn 状态        |
| turn/diff/updated                 | threadId、turnId、diff        | 当前 diff             |
| item/started                      | threadId、turnId、item        | item 开始             |
| item/completed                    | threadId、turnId、item        | item 最终状态         |
| item/agentMessage/delta           | itemId、delta、seq            | assistant 增量        |
| item/plan/delta                   | itemId、delta、seq            | plan 增量             |
| item/commandExecution/outputDelta | itemId、stream、delta         | command 输出          |
| serverRequest/resolved            | requestId、threadId、turnId   | Server Request 已处理 |
| skills/changed                    | cwd、paths                    | skill 文件改变        |
| warning                           | code、message、details        | 非终止警告            |

每个 thread-scoped notification 都带 threadId 和 seq；turn/item notification 还带 turnId/itemId。Client 不用时间戳推导顺序。

### 6.6 ThreadItem union

协议层继续使用 `ThreadItem` 作为资源表示；它对应 `domain/item` 中的 `Item`，不是新的 coding-specific session event。Thread、Turn、Item 的身份和生命周期分别由 `domain/thread`、`domain/turn`、`domain/item` 定义。

```ts
type ThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | PlanItem
  | CommandExecutionItem
  | FileChangeItem
  | ToolCallItem
  | SubagentItem
  | ContextCompactionItem
  | NoticeItem
  | ErrorItem;

interface UserMessageItem {
  type: "userMessage";
  id: string;
  text: string;
}

interface AgentMessageItem {
  type: "agentMessage";
  id: string;
  text: string;
  phase: "commentary" | "final";
  status: "inProgress" | "completed" | "failed";
}

interface CommandExecutionItem {
  type: "commandExecution";
  id: string;
  command: string;
  cwd: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  outputPreview?: string;
  exitCode?: number;
  durationMs?: number;
}

interface FileChangeItem {
  type: "fileChange";
  id: string;
  changes: readonly FileChange[];
  status: "inProgress" | "completed" | "failed" | "declined";
}
```

Server 可以在内部保存完整 tool input/output，但 wire payload 必须使用 item-specific redaction：

- command 只传可展示的 argv/cwd 摘要；
- filesystem 只传相对 workspace path；
- 大输出先写 artifact，再传 artifactId、preview 和 byte count；
- provider response、API key、环境变量和原始 secret 永不进入 item；
- item/completed 的字段不能由 Client 自己补齐。

### 6.7 Server Request：审批和用户输入

Server Request 采用 JSON-RPC request，不再定义 approval.pending + approval.respond：

```json
{
  "jsonrpc": "2.0",
  "id": "srvreq_01J...",
  "method": "item/commandExecution/requestApproval",
  "params": {
    "threadId": "thr_01",
    "turnId": "turn_01",
    "itemId": "item_01",
    "reason": "Command requires project write access",
    "command": ["pnpm", "test"],
    "cwd": "/workspace/project",
    "availableDecisions": ["accept", "acceptForSession", "decline", "cancel"]
  }
}
```

Client response：

```json
{
  "jsonrpc": "2.0",
  "id": "srvreq_01J...",
  "result": {
    "decision": "acceptForSession"
  }
}
```

第一版 Server Request：

- item/commandExecution/requestApproval；
- item/fileChange/requestApproval；
- item/permissions/requestApproval；
- item/tool/requestUserInput；
- item/plan/requestApproval。

生命周期：

1. Thread runtime 创建 pending interaction；
2. PendingServerRequestStore 持久化 request metadata；
3. Server 只发给当前 controller connection；
4. 第一条合法 response 完成 request；
5. Server 恢复 deferred tool/turn；
6. 发布 serverRequest/resolved；
7. 其他重复 response 返回 requestResolved。

Client 断开时 request 不被默认 deny。新 Client thread/resume 时，Server 重新发送仍 pending 的 request。Server restart 无法恢复正在执行的模型 HTTP stream；这种 turn 被标记 interrupted，但已落盘的 pending approval 可以恢复。

### 6.8 错误模型

JSON-RPC 标准错误码：

| code   | data.type            | 典型情况                     |
| ------ | -------------------- | ---------------------------- |
| -32700 | parseError           | JSON 解析失败                |
| -32600 | invalidRequest       | 顶层 shape 错误              |
| -32601 | methodNotFound       | 未实现 method                |
| -32602 | invalidParams        | zod schema 失败              |
| -32603 | internal             | 未分类内部错误               |
| -32001 | serverOverloaded     | 入站/出站队列已满            |
| -32002 | notInitialized       | 未完成握手                   |
| -32003 | alreadyInitialized   | 重复握手                     |
| -32004 | threadNotFound       | thread 不存在                |
| -32005 | threadBusy           | mutation 冲突                |
| -32006 | turnMismatch         | expectedTurnId 不匹配        |
| -32007 | requestResolved      | 重复/过期 response           |
| -32008 | permissionDenied     | 当前 capability 或规则不允许 |
| -32009 | pathOutsideWorkspace | 路径逃逸                     |
| -32010 | storageCorrupt       | 持久化记录非法               |
| -32011 | protocolMismatch     | protocolVersion 不支持       |

data.retryable 必须由 Server 填充。Client 只对明确标记 retryable 的 transport/overload 错误重试；业务错误不重试。

## 7. 持久化和恢复

### 7.1 数据所有权

| 数据                                  | 唯一事实源                                  | Client 是否可写 |
| ------------------------------------- | ------------------------------------------- | --------------- |
| thread/turn/item 历史                 | thread JSONL append-only log                | 否              |
| thread catalog、分页索引              | SQLite projection                           | 否              |
| workspace/repo/task/usage             | SQLite repository                           | 否              |
| 大 tool output、diff、导出            | content-addressed artifact store            | 否              |
| provider/config                       | global/project YAML + Server config manager | 只能通过 RPC    |
| theme、terminal keymap、最近 endpoint | @ello/tui local UI config                   | 是              |

模型 transcript 的正文仍以 thread log 为主源，SQLite 只做索引和聚合。任何 projection 都可以从 log 重建；不能反过来用缓存猜测 transcript。

### 7.2 新 thread log

新 schema 使用独立目录：

```text
~/.ello/
├── threads/
│   ├── active/<threadId>.jsonl
│   └── archived/<threadId>.jsonl
├── state/
│   └── ello.sqlite
├── artifacts/
├── logs/
└── run/
    └── app-server.sock
```

每行是严格 zod record：

```ts
interface ThreadRecordBase {
  schema: 1;
  seq: number;
  threadId: string;
  createdAt: string;
  kind: string;
}

type ThreadRecord =
  | ThreadHeaderRecord
  | ThreadMetadataRecord
  | TurnStartedRecord
  | TurnCompletedRecord
  | TurnInterruptedRecord
  | TurnFailedRecord
  | ItemStartedRecord
  | ItemDeltaRecord
  | ItemCompletedRecord
  | TranscriptEntryRecord
  | CompactionRecord
  | GoalStateRecord
  | PlanStateRecord
  | ContentReplacementRecord
  | ServerRequestRecord
  | ServerRequestResolvedRecord;
```

写入规则：

- append 由每个 thread 的 single writer 串行执行；
- 每条记录写完整 newline 后才增加 seq；
- authoritative completion 记录必须 flush；
- 最后一行不完整、seq 倒退、threadId 不匹配或 record kind 与 payload 不匹配都触发 storageCorrupt；
- 不在启动时静默 truncate 或跳过坏行；
- 诊断命令可以把坏文件复制到 recovery 目录，但不修改原文件。

delta 是否每 token 持久化要有明确策略：第一版采用有界 chunk（最多 4 KiB 或 50 ms 一条）并在 item/completed 前 flush。这样可以在断线时恢复已显示的文本，又不会产生每 token 一次 fsync。

### 7.3 SQLite migrations

`storage/database/schema.ts` 是唯一 schema 定义，`drizzle-kit` 生成 baseline 和 journal，Server 启动时直接调用 Drizzle migrator。运行时不识别旧 ledger、不接管无 journal 的已有 schema，也不维护第二套 migration executor。

```text
storage/migrations/
├── 0000_tiny_swordsman.sql
└── meta/
    ├── 0000_snapshot.json
    └── _journal.json
```

baseline 同时创建 workspace、artifact、task、usage 和 Thread/Turn/Item catalog；Drizzle schema 无法表达的 workspace checkout 校验 trigger 直接写在同一 baseline SQL 中。

所有 repository 写入必须在 transaction 内完成；JSONL append 和 SQLite projection 的顺序由 ThreadLogRepository 和 ThreadRuntime 统一管理，业务 service 不得自行双写。

### 7.4 Server restart

启动扫描：

1. 校验 catalog/schema；
2. 扫描 active thread 的最后记录；
3. 对没有终态的 turn 写入 turn-interrupted recovery record；
4. 对 inProgress item 写入 interrupted/failed completion；
5. 把未完成 Server Request 标记为 cancelledByRestart；
6. 重建 SQLite projection；
7. Server ready 后才接受 thread/resume。

不尝试恢复：

- 已断开的模型 HTTP stream；
- 已不存在的子进程/PTY；
- 旧进程内的 AbortController；
- 没有持久化 input 的临时 steering。

### 7.5 旧数据策略

正常 Server 启动只读取 threads/ 新目录。当前 ~/.ello/sessions/\*.jsonl 和 schema v3 不被新 runtime 读取，也不在同一目录上尝试猜测版本。

如需保留历史：

1. `ello migrate sessions --input <path> --output <path>` 作为由 ello-tui 提供的一次性离线命令；
2. 输入和输出 schema 都显式指定；
3. 每个文件先完整校验，再原子写新文件；
4. 失败时保留原文件并报告行号；
5. importer 不被 AgentServer.start() 调用；
6. 发布稳定版前决定是否从仓库删除 importer。

## 8. Transport、进程和鉴权

### 8.1 Transport 接口

业务只依赖：

```ts
interface AppServerTransport {
  readonly kind: "stdio" | "websocket" | "unix";
  readonly connectionId: string;
  messages(): AsyncIterable<Uint8Array>;
  send(message: Uint8Array): Promise<void>;
  close(reason?: string): Promise<void>;
}
```

实现：

- StdioTransport：stdin/stdout JSONL，EOF 触发 connection close；
- WebSocketTransport：一帧一个 JSON-RPC message，支持 ping/pong 和 bounded queue；
- UnixSocketTransport：HTTP Upgrade 到 WebSocket，socket 文件权限 0600；
- health endpoint 只在 WebSocket/Unix HTTP listener 上提供 /readyz、/healthz。

所有 transport 进入同一个 MessageProcessor。不要在 websocket.ts 里复制 method dispatch。

### 8.2 本地 CLI 启动链

默认执行 ello：

```text
parse client options
  -> resolve @ello/agent/server-entry
  -> spawn node <server-entry> --listen stdio://
  -> create StdioTransport over child stdin/stdout
  -> initialize / initialized
  -> thread/start or thread/resume
  -> launch Ink TUI
  -> interrupt active turn on exit
  -> server/shutdown
  -> wait child exit, timeout then terminate
```

约束：

- Server stdout 只能输出 JSON-RPC；日志写 stderr；
- child 的 cwd 使用用户传入的本地 workspace；
- provider secrets 只在 child env 中可见，不复制到 Client config；
- server-launcher.ts 只负责 spawn/kill/stdio，不 import Server service；
- server child 启动失败直接显示 stderr 和退出码，不退回旧的 in-process runtime；
- ello run、ello resume、management command 都复用同一个 Client bootstrap。

### 8.3 长期 Server

通过 `ello-tui` 的公共 CLI 运行：

```bash
ello app-server --listen ws://127.0.0.1:4500
ello app-server --listen unix:///absolute/path/to/ello.sock
ello --remote ws://127.0.0.1:4500
ello --remote unix:///absolute/path/to/ello.sock
```

`ello app-server` 是 @ello/tui 中的公共命令，只负责把参数转发给 `@ello/agent/server-entry`；它不重新实现 Server。默认 ello 不隐式发现一个未知的全局 daemon，也不在连接失败时 fallback 到本地旧 runtime。

### 8.4 WebSocket 鉴权

- loopback 开发连接可以显式选择 capability token；
- 非 loopback ws:// 一律拒绝，要求 wss:// 或受保护的 SSH tunnel；
- token 从 --remote-auth-token-env ENV_NAME 读取，不把 raw token 放在 argv 或 URL query；
- Unix socket 依赖文件权限，必要时再叠加 token；
- WebSocket upgrade 前完成 auth，initialize 之前不接受未认证连接；
- Origin header 不是认证机制；带不允许 Origin 的浏览器请求返回 403；
- token 校验失败不泄露是 token 不存在、过期还是 capability 不足。

### 8.5 Capability

Server Request 和 mutation 需要 capability：

| capability | 能力                                     |
| ---------- | ---------------------------------------- |
| read       | list/read/history/files read             |
| submit     | start/steer/interrupt turn               |
| approve    | approval/user input/plan decisions       |
| write      | config/workspace/task/file mutation      |
| admin      | server shutdown/device/token/diagnostics |

stdio child 默认拥有全部 capability；远程 token 必须显式列出。Client UI 只根据 Server 返回的 capability 显示/禁用按钮，最终授权仍在 Server 校验。

### 8.6 背压

- 每个 connection 的 inbound queue 和 outbound queue 都有固定容量；
- inbound 满返回 serverOverloaded，不把 request 放进无界 Promise；
- outbound 满时优先保留 Server Request、item completed、turn completed 和 error；
- best-effort progress 可以合并；不可丢弃的消息不能静默丢弃；
- 慢 connection 被单独断开，不阻塞其他 thread；
- Client 收到 lagged 或 seq gap 必须执行 thread/resume，不继续渲染不完整历史。

## 9. @ello/tui Client 和 TUI 重构

### 9.1 AppServerClient

参考 Codex 的 app_server_session.rs，把所有 RPC plumbing 收敛到 typed client facade：

```ts
export interface AppServerClient {
  connect(): Promise<void>;
  initialize(params: InitializeParams): Promise<InitializeResult>;
  request<M extends ClientMethod>(
    method: M,
    params: ClientParams<M>,
  ): Promise<ClientResult<M>>;
  notify<M extends ClientNotificationMethod>(
    method: M,
    params: ClientNotificationParams<M>,
  ): Promise<void>;
  onNotification(listener: NotificationListener): () => void;
  onServerRequest(listener: ServerRequestListener): () => void;
  close(): Promise<void>;
}
```

实现分层：

- api/transport.ts 只处理 bytes/message；
- api/client.ts 只处理 request id、pending map、parse/validation；
- api/server-requests.ts 只处理 Server Request response；
- client/thread-client.ts 把 method 调用整理成 TUI 可用的 thread facade；
- tui/App.tsx 只调用 ThreadClient，不看 raw JSON-RPC。

request() 的错误必须区分：

1. transport closed；
2. server JSON-RPC error；
3. response schema mismatch；
4. request timeout。

### 9.2 ThreadClient

TUI 需要的 facade：

```ts
interface ThreadClient {
  readonly threadId: string;
  readonly cwd: string;
  subscribe(listener: (event: ClientEvent) => void): () => void;
  loadHistory(): Promise<void>;
  submit(input: string, metadata?: Record<string, string>): Promise<string>;
  steer(input: string): Promise<void>;
  interrupt(reason?: string): Promise<void>;
  approve(requestId: string, decision: ApprovalDecision): Promise<void>;
  resolveUserInput(
    requestId: string,
    value: UserInputResolution,
  ): Promise<void>;
  setMode(mode: SessionMode): Promise<void>;
  setProfile(profile: string): Promise<void>;
  setModel(model: string): Promise<void>;
  startNewThread(): Promise<string>;
  fork(lastTurnId?: string): Promise<string>;
  resume(threadId: string): Promise<void>;
  close(): Promise<void>;
}
```

它不是旧 CodingSession 的 compatibility wrapper：

- 不暴露 Server service；
- 不允许修改自身 threadId；切换 thread 返回新的 ThreadClient；
- subscribe() 消费协议 notification，并维护 local projection；
- approve() 回应 JSON-RPC Server Request，而不是发送旧 command。

### 9.3 Client reducer

当前 tui/store/tui-event-store.ts 直接 reduce CodingSessionEvent，需要改成两层：

1. protocolEventReducer：按 threadId/turnId/itemId/seq 更新 authoritative client model；
2. presentationReducer：把 item model 映射成历史行、tool card、overlay 和计时器。

规则：

- item/started 创建临时 item；
- delta 只更新同 id 的临时内容；
- item/completed 用完整 item 覆盖临时内容；
- turn/completed 清理 active turn 并显示终态；
- seq gap 设置 stale: true，禁用 submit，后台调用 thread/resume；
- duplicate seq/id 必须幂等，不重复插入历史；
- Server warning 显示为 notice，不伪造成 assistant message；
- Server Request 进入 pending interaction store，不进入普通 timeline。

### 9.4 TUI 目录边界

当前 tui/App.tsx 中的这些直接调用必须替换：

| 当前行为                               | 新行为                                          |
| -------------------------------------- | ----------------------------------------------- |
| createCodingSession()                  | createLocalServerClient() + thread/start/resume |
| session.subscribe()                    | ThreadClient.subscribe()                        |
| session.submit()                       | turn/start                                      |
| session.steer()                        | turn/steer                                      |
| session.abort()                        | turn/interrupt                                  |
| session.approve()                      | 回应 pending Server Request                     |
| session.loadHistory()                  | thread/read/thread/turns/list                   |
| session.listSkills()                   | skills/list                                     |
| session.listSubagents()                | agent/list                                      |
| session.listTasks()                    | task/list                                       |
| session.runShell()                     | thread/shellCommand                             |
| 本地 readdir completion                | fs/search                                       |
| 直接 setConfigValue/deleteConfigValues | config/write                                    |
| 直接 createProviderRegistry            | provider/list、model/list                       |
| 直接读取 plan artifact                 | thread/plan/preview                             |
| 直接 export 文件                       | thread/export，由 Client 决定本地落盘           |

TUI 可以读取自己的 local UI config，但不能读取 Server config 来决定权限或模型。Server 返回的 InitializeResult、thread snapshot 和 catalog response 是唯一数据源。

### 9.5 CLI 命令迁移

当前 packages/ello-coding-agent/src/cli 的 command modules 全部移动到 ello-tui/src/cli/commands；ello-agent 不创建对应的 CLI。handler 只做三件事：

1. 解析 argv；
2. 建立 Client；
3. 调用 typed RPC 并渲染 response/notification。

映射：

| 当前命令                   | 新 Client 行为                                         |
| -------------------------- | ------------------------------------------------------ |
| 无子命令                   | local stdio Server + TUI                               |
| run <prompt>               | start/resume thread，turn/start，消费至 turn/completed |
| resume [id]                | thread/list picker 或 thread/resume                    |
| sessions                   | thread/list                                            |
| tools                      | tool/list                                              |
| providers list/doctor      | provider/list                                          |
| models list/show           | model/list                                             |
| permissions                | config/read + permission summary                       |
| memory status/reload/dream | memory/\*                                              |
| goal                       | thread/goal/\*                                         |
| task ...                   | task/\*                                                |
| skills ...                 | skills/\*                                              |
| repo ...                   | repo/\*                                                |
| workspace ...              | workspace/\*                                           |
| config ...                 | config/\*                                              |
| app-server                 | spawn/exec ello-agent entry                            |

--json 模式输出一行一个完整 JSON-RPC result/notification，不把 Server 的 stderr 混入 stdout。--no-tui 仍是 Client，不是重新创建 in-process session。

## 10. 代码合并和文件迁移

### 10.1 第一轮：合并 engine

把当前 ello-agent 的以下目录迁入 packages/ello-agent/src/agent/engine，只改 import 和 exports：

- src/core/\*；
- src/adapters/\* 迁入 agent/providers/ai-sdk；
- src/environment/\* 迁入 agent/environment；
- src/public/types.ts、model.ts、tool.ts、events.ts、persistence.ts 按职责拆入 agent/engine、agent/tools、agent/environment；
- engine 相关测试。

迁移原则：

- 先把 public 改名为 engine-api 或 private types，避免把 SDK 语义继续暴露；
- Agent 类型改为 internal EngineAgent；
- AgentStreamEvent 改为 internal EngineEvent；
- createAgent 改成 createEngineAgent，只在 Server factory 内可见；
- 删除根出口的 SDK 示例和 public API tests；
- engine 仍然保留 provider adapter 和 deferred resume，但其 caller 只能是 Server runtime。

### 10.2 第二轮：吸收 coding-agent Server code

从 packages/ello-coding-agent/src 移入 packages/ello-agent/src：

| 当前目录                   | 目标目录                              | 处理                                                        |
| -------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| agents                     | agent/subagents                       | 保留 registry、subagent、background job，改用固定 thread id |
| change                     | domain/item + storage/artifacts       | checkpoint 与 diff 归 thread/turn                           |
| config                     | config                                | CodingAgentConfig 改名 AgentServerConfig                    |
| context                    | agent/context                         | prompt/compaction/tool budget                               |
| goal                       | agent/goals                           | GoalService 依赖固定 thread                                 |
| memory                     | agent/memory                          | worker 改成 process-scoped，任务关联 thread                 |
| observability              | observability                         | Server-only recorder                                        |
| permission、permissions.ts | agent/permissions                     | 所有判定留 Server                                           |
| plan                       | agent/plans + storage/artifacts       | plan artifact 和 hash 状态机                                |
| provider                   | agent/providers                       | provider/model catalog                                      |
| session                    | domain + storage/threads              | 重写为 thread log，不保留 v3 parser                         |
| skills                     | agent/skills                          | Server watcher/loader                                       |
| storage                    | storage                               | process-owned storage                                       |
| tasks                      | server/methods + storage/repositories | RPC handler 和持久化分离                                    |
| tools                      | agent/tools                           | 只在 Server 创建和执行                                      |
| user-input                 | server/interaction                    | 连接到 Server Request broker                                |
| workspace                  | workspace                             | RPC handler 只在 server/methods                             |
| utils/yaml.ts              | config/yaml.ts                        | Server config only                                          |
| utils/boot-profile.ts      | observability/boot-profile.ts         | Client 和 Server 分开实现                                   |

### 10.3 第三轮：拆 coding-session.ts

不直接把 2,808 行文件搬到新包。按以下顺序拆：

1. 把 CreateCodingSessionOptions 改成 AgentServerContext 的显式依赖；
2. 提取 ThreadRuntime 的固定身份、snapshot 和 subscription；
3. 提取 TurnController 的 submit/steer/abort/driveRun；
4. 提取 InteractionCoordinator 的 approval/user input/deferred resume；
5. 提取 AgentFactory 的 buildAgent；
6. 提取 ThreadSettingsService 的 profile/model/mode/agent；
7. 提取 ThreadHistoryService 的 read/fork/export/compaction；
8. 把 GoalService、MemoryJobCoordinator、BackgroundJobStore 的生命周期提升到明确的 process/thread owner；
9. 删除 CodingSessionImpl，让编译器暴露所有旧调用点；
10. 用 RPC request processors 重新连接这些 service。

目标是每个核心模块少于约 500 行，绝不把所有 Server 逻辑合并到新的 server.ts。

### 10.4 第四轮：协议和 App Server

新增：

- src/protocol/v1/\*；
- src/server/connection/\*；
- src/server/rpc/\*；
- src/server/transport/\*；
- src/server/methods/\*；
- protocol schema fixture；schema generation 不是第一版阻塞项。

实现顺序：

1. zod wire schemas；
2. JSONL framing/parser；
3. connection state + initialize gate；
4. request id map + response writer；
5. thread/start/read/resume/list；
6. turn/start + notification；
7. projection/item lifecycle；
8. Server Request broker；
9. 其他 catalog/service methods；
10. WebSocket/Unix transport。

### 10.5 第五轮：创建 ello-tui

1. 复制 TUI 组件、主题、UI utility 和 TUI tests 到新包；
2. 复制 CLI parser/render tests；
3. 删除所有 @ello/coding-agent imports；
4. 实现 api transport/client；
5. 实现 local child server launcher；
6. 把 CodingSession props 替换为 ThreadClient；
7. 重写 use-runtime-events 和 tui-event-store；
8. 将 config/provider/filesystem/goal/task 操作改成 RPC；
9. 把 slash-commands 变成纯 Client command intent；
10. 更新 package/bin/docs。

### 10.6 必须删除的旧入口

完成 cutover 后删除：

- packages/ello-coding-agent 整个目录；
- src/runtime/coding-session.ts；
- src/runtime/intents.ts 的跨包事件 contract；
- src/public/create-agent.ts、src/public/agent.ts 的 SDK public surface；
- createCodingSession、launchTui 的旧 package exports；
- approval.respond 或同名旧 command；
- 旧 session/schema.ts v3 parser；
- sessionId 可变 session facade；
- TUI 直接访问 Server service 的 imports；
- old package scripts、lockfile link、README architecture；
- 任何 @ello/agent/internal 或 @ello/coding-agent re-export alias。

## 11. Package manifest 和构建

### 11.1 @ello/agent

`@ello/agent` 不声明 `bin`，不提供 `ello` 命令，也不包含 Commander。`server-entry` 只是供 `@ello/tui` 启动子进程的 package export。

依赖归属：

- AI SDK、provider packages、zod；
- better-sqlite3、drizzle、yaml、nunjucks、tinyglobby、diff；
- OpenTelemetry/Langfuse；
- ws 及 Node 类型；
- `node:util.parseArgs` 仅用于解析 `server/entry.ts` 的内部启动参数，不引入 Commander，也不提供 Server CLI command tree。

脚本：

```json
{
  "build": "node scripts/build.mjs",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "lint": "eslint src",
  "test": "vitest run",
  "verify-dist": "node scripts/verify-dist.mjs"
}
```

build 必须复制：

- config templates；
- context prompts；
- bundled agents；
- storage migrations；
- protocol v1 schema assets（如有静态 fixture）。

第一版不把 schema generation 作为必需脚本；zod/TypeScript schema 源码直接随包构建。后续如果需要对外发布 JSON Schema，再增加显式的可选生成命令，不影响 Server 启动。

verify-dist.mjs 必须验证所有资源存在、Server stdout 不包含日志初始化、Server entry 可执行、构建产物没有 Client/TUI import。

这两个脚本只服务构建和发布校验，不是运行时架构的一部分：`build.mjs` 用于复制 prompts、bundled agents、templates 和 migrations 等非 TypeScript 资源；`verify-dist.mjs` 用于 CI/发布前 fail-fast 校验。它们不承载 CLI command，也不提供第二套 Server 启动路径。

### 11.2 @ello/tui

`@ello/tui` 声明唯一的 `ello` bin，并拥有所有 public command modules，包括 `app-server` 转发命令。

依赖归属：

- @ello/agent（只用 protocol 和 server entry）；
- commander；
- ink、react、@inkjs/ui、ink-text-input；
- ws client；
- ink-testing-library、vitest。

不应依赖：

- better-sqlite3；
- drizzle；
- AI SDK provider；
- Langfuse/OpenTelemetry Server runtime；
- Server 的 config/storage/tool implementation。

### 11.3 包版本

两包同步进入新的 breaking major（当前 0.1.0 不再作为兼容标识）。发布前在 package metadata 和 protocol serverInfo.version 中统一版本来源，禁止手工维护多个不一致常量；Ello application protocol 固定为 v1，不能与 JSON-RPC 2.0 混写。

## 12. 分阶段实施计划

阶段可以在同一 feature branch 内逐步落地，但不通过 feature flag 在生产运行时保留两条路径。

### Phase 0：基线、ADR 和删除边界

代码任务：

- 冻结当前 branch 的 test/build baseline；
- 新增本计划和 ADR，明确 @ello/agent Server、@ello/tui Client；
- 在 issue/PR 中列出旧 exports、旧 package 和旧 storage schema 的删除清单；
- 停止向 ello-coding-agent 增加新功能。

验证：

- 当前 pnpm -r typecheck/test/build/lint 结果记录下来；
- 搜索并记录所有 createCodingSession、createAgent、CodingSessionEvent 调用点；
- 确认没有未提交用户改动被覆盖。

出口条件：

- 目标 package graph 和 protocol 命名已固定；
- 后续代码不再以兼容为设计约束。

### Phase 1：新 package skeleton 和 protocol v1 schema

代码任务：

- 创建 packages/ello-tui；
- 在 ello-agent/src/protocol/v1 建立 strict zod schemas；
- 定义 JSON-RPC request/response/notification/server-request；
- 定义 protocol version、capabilities、error codes；
- 写 JSON fixtures 和 TypeScript exports；schema generator 作为后续可选工具，不作为第一版构建依赖；
- 建立 rpc-client 的纯 parser/validator（先用 fake transport）。

测试：

- 每个稳定 method 的 valid/invalid round trip；
- camelCase、null/optional、unknown field；
- request id string/number；
- parse error、invalid request、method not found；
- experimental capability gate；
- protocol fixture drift。

出口条件：

- schema 是唯一 wire source；
- Client 和 Server 都从同一 schema 验证；
- 没有 v2/legacy schema。

### Phase 2：合并 engine 和 Server-owned capabilities

代码任务：

- 将 ello-agent engine/private API 迁入新目录；
- 将 coding-agent 的 config/provider/tool/permission/context/goal/plan/memory/workspace/storage 能力迁入 ello-agent 的对应顶层目录；
- 更新所有相对 import；
- 把 SDK public API 改为 private engine API；
- 迁移纯 Server 单元测试；
- 保证服务仍能在没有 TUI 的测试进程中创建。

测试：

- engine loop、tool scheduler、provider adapter 原有测试；
- config/storage/workspace/task/memory/permission 原有测试；
- package exports 测试确认无 createAgent SDK surface；
- Server package typecheck/lint。

出口条件：

- ello-agent 可以独立 import 所有 Server service；
- ello-tui 尚未接入这些内部模块；
- ello-coding-agent 只作为临时迁移源，不再新增逻辑。

### Phase 3：不可变 Thread/Turn runtime

代码任务：

- 实现 AgentServerContext；
- 实现 ThreadRuntime、ThreadManager、ThreadSnapshot；
- 从 coding-session.ts 提取 TurnController；
- 把 runId/turnIndex 内部重命名为 turnExecutionId/stepIndex；
- 把 goal、plan、memory、background job 关联到固定 thread；
- 删除 session identity mutation；
- 为每个 thread 加串行 command queue。

测试：

- 两个 thread 并行执行且 storage/runtime 不串；
- 同一 thread 第二个 turn 被拒绝；
- fork 产生全新对象和 id；
- close 一个 thread 不关闭 process storage；
- steer/interrupt stale id；
- active turn 生命周期。

出口条件：

- 没有可变 CodingSession 或 CodingThread；
- ThreadManager 是唯一创建/恢复/fork 入口；
- read 可以不加载 Agent runtime。

### Phase 4：新持久化和 recovery

代码任务：

- 实现 thread JSONL schema v1；
- 拆分 session/repository.ts 为 log writer、projector、catalog、history service；
- 用 Drizzle schema 生成单一 SQLite baseline；
- 实现 event seq、chunked delta、flush；
- 实现 startup recovery；
- 加入 archive/thread lock；
- 明确旧 v3 数据不在 runtime 读取。

测试：

- 完整 thread/turn/item 写入读取；
- fork 和 history pagination；
- compaction、goal、plan、artifact reference；
- 半行、seq gap、wrong thread id 的 fail-fast；
- restart 把 active turn 标成 interrupted；
- thread/read 不触发 provider 初始化；
- catalog rebuild 和 pagination。

出口条件：

- 持久化是 reconnect/restart 的主源；
- 不需要内存 cursor 才能恢复 timeline；
- Server 可从全新 ~/.ello/threads 启动。

### Phase 5：stdio App Server

代码任务：

- 实现 JSONL StdioTransport；
- 实现 ConnectionState、initialize gate、request map；
- 实现 outgoing queue、server request callback map；
- 实现 AgentServer.start/stop；
- 实现 `server/entry.ts` 的 stdio:// 启动参数；公共 `ello app-server` 命令由 ello-tui 提供；
- 实现 server/read、server/shutdown；
- 让 thread/start/read/list/resume 走真实 JSON-RPC。

测试：

- spawn 真正的 node dist/server/entry.js；
- initialize/initialized 顺序；
- stdout 只有 JSON，stderr 只有日志；
- request id correlation；
- malformed line 和 oversize line；
- EOF、SIGTERM、graceful shutdown；
- child 退出码和 stderr 传递。

出口条件：

- 不 import TUI，Server 可独立作为进程运行；
- fake model provider 下可以完成 start thread -> start turn -> completed 的最小链路。

### Phase 6：Turn projection 和双向交互

代码任务：

- 实现 EngineEvent projector；
- 实现 item start/delta/completed；
- 实现 turn start/completed；
- 实现 approval/user input/plan Server Request；
- 实现 pending request persistence、first response wins、resolved notification；
- 实现 controller connection 和 thread subscription；
- 实现 reconnect 后 pending request 重发。

测试：

- assistant delta、tool、file change、subagent、compaction；
- approve once/session/deny；
- user input schema validation；
- 同一 request 重复 response；
- disconnect 后 approval 仍 pending；
- 新 connection resume 并接管；
- wire payload 不泄露原始 secret/tool input。

出口条件：

- Server notification 足以还原 TUI timeline；
- Client 不再消费 CodingSessionEvent；
- Server Request 不再是普通 event。

### Phase 7：ello-tui Client 和 non-interactive CLI

代码任务：

- 实现 StdioChildTransport、WebSocketTransport、UnixTransport；
- 实现 AppServerClient、ThreadClient；
- 把 run、resume、sessions、models、providers、config 等 CLI 改成 RPC；
- 删除 CLI 对 storage/provider/config implementation 的 import；
- --json 输出规范化 RPC stream；
- 做 local child lifecycle 管理。

测试：

- fake transport request/response；
- real child stdio bootstrap；
- server error/timeout/closed handling；
- run 命令收到 turn/completed 才退出；
- child shutdown timeout；
- remote endpoint parse/auth env。

出口条件：

- ello run 不创建本地 Agent；
- ello 无子命令只启动 Client/TUI；
- management command 与 TUI 使用同一个 Client bootstrap。

### Phase 8：TUI cutover

代码任务：

- 把 UI 文件移入 ello-tui/src/tui；
- App props 改为 ThreadClient；
- 重写 use-runtime-events、timeline reducer、approval overlay、user input panel；
- 把 file completion、config panel、model/profile selector、task/goal/memory overlay 改成 RPC；
- 将 Server Request 与普通 timeline 分离；
- 保留主题、键盘、组件视觉行为，不保留 session runtime 依赖。

测试：

- reducer item lifecycle/seq gap/duplicate；
- AppShell、Composer、Overlay、HistoryRenderer；
- approval/user input interaction；
- local server disconnect/reconnect state；
- JSON text renderer 与 TUI 共享 protocol fixtures。

出口条件：

- tui/App.tsx 不 import Server service；
- TUI 关闭只关闭 Client 和 owned child，不直接 close storage；
- TUI 视觉测试不需要真实 provider/SQLite。

### Phase 9：workspace/config/skills/memory 全面 RPC 化

代码任务：

- 完成 repo/_、workspace/_ request processors；
- 完成 config/read/write/sources/init；
- 完成 skills/_、memory/_、task/_、goal/_；
- 处理 remote path/output 语义；
- 把 server-side artifact export 变成 stream/handle；
- 让 TUI 的 slash command 只产生 Client intent。

测试：

- 每个 CLI command 的 RPC integration；
- workspace transaction 和错误映射；
- remote cwd/path validation；
- config source precedence；
- skills reload event；
- memory job progress/completion。

出口条件：

- 所有产品能力均有明确 Server handler；
- 没有 CLI handler 直接碰数据库或 YAML。

### Phase 10：WebSocket、Unix、鉴权和运维

代码任务：

- WebSocket/Unix transport；
- /readyz、/healthz；
- token file/hash、signed bearer；
- capability check；
- socket permission、server lock、graceful signal；
- systemd/container 启动文档；
- ello --remote 和 auth env。

测试：

- loopback/non-loopback policy；
- token missing/expired/revoked；
- capability read vs submit vs approve；
- slow client isolation；
- two clients subscribing different threads；
- controller disconnect/resume；
- SIGTERM with active turn。

出口条件：

- 本地 stdio 和远程 WebSocket 使用同一 request processor；
- 非 loopback 无认证连接无法建立；
- 多连接不会互相阻塞。

### Phase 11：删除旧包、清理和发布

代码任务：

- 删除 packages/ello-coding-agent；
- 更新 pnpm-workspace.yaml、lockfile、root scripts；
- 更新 README、package exports、build assets；
- 删除旧 schema、old tests、old docs architecture；
- 增加 import boundary、protocol fixture drift、secret scan；
- 统一版本号。

验收：

- 全仓搜索无 createCodingSession、CodingSessionEvent、approval.respond、@ello/coding-agent；
- 无 createAgent production export；
- ello-agent 可独立启动；
- ello-tui bundle 不含 better-sqlite3、AI SDK、Server implementation；
- local stdio 与 remote WebSocket 通过同一端到端套件。

## 13. 测试矩阵

### 13.1 @ello/agent agent/domain/storage

- model adapter protocol；
- engine loop、stream、run control；
- tool scheduler 和 deferred resume；
- config schema/source precedence；
- permission path/realpath/symlink；
- provider/model registry；
- tools、plan、goal、memory、skills；
- workspace/repo/task repository；
- artifact and usage persistence；
- thread log schema/projector；
- restart recovery。

### 13.2 @ello/agent App Server

- JSON-RPC schema fixture；
- initialize gate；
- request serialization；
- connection registry/subscription；
- outgoing queue/backpressure；
- thread manager lifecycle；
- server request callback；
- stdio framing；
- WebSocket auth/health；
- Unix socket permissions；
- graceful shutdown；
- real process integration。

### 13.3 @ello/tui

- transport parser/client pending map；
- typed request/response error；
- reconnect/stale state；
- Server Request handler；
- protocol reducer；
- timeline/history projection；
- Composer/slash command；
- approval/user input overlay；
- model/profile/settings overlays；
- local UI config；
- CLI text/JSON renderer；
- process launcher。

### 13.4 端到端必须覆盖

1. spawn `@ello/agent/server-entry`；
2. initialize/initialized；
3. thread/start；
4. turn/start；
5. assistant delta；
6. command approval Server Request；
7. file change item；
8. user input Server Request；
9. turn/completed；
10. client disconnect；
11. Server 继续或明确中断；
12. thread/resume；
13. history/item snapshot；
14. fork 新 thread；
15. config/model/goal/task RPC；
16. graceful shutdown；
17. remote WebSocket auth；
18. slow-client/backpressure。

集成测试必须 spawn 实际 build 后的 Server。可以用 mock upstream HTTP provider，而不能通过 modelAdapter 注入绕过进程边界来证明 App Server 工作。

## 14. 验证命令

重构完成后的仓库应提供：

```bash
pnpm install
pnpm --filter @ello/agent typecheck
pnpm --filter @ello/agent lint
pnpm --filter @ello/agent test
pnpm --filter @ello/agent build
pnpm --filter @ello/tui typecheck
pnpm --filter @ello/tui lint
pnpm --filter @ello/tui test
pnpm --filter @ello/tui build
pnpm -r test
pnpm -r build
pnpm lint
pnpm typecheck
git diff --check
```

本地真实入口验证：

```bash
node packages/ello-agent/dist/server/entry.js --listen stdio://
node packages/ello-tui/dist/cli/main.js --help
pnpm --filter @ello/tui run ello --help
pnpm --filter @ello/tui run ello -- app-server --listen ws://127.0.0.1:4500
```

CI 额外检查：

- protocol v1 fixtures 无漂移；
- ello-tui 构建产物不含 Node-only Server dependency；
- no-restricted-imports 边界；
- @ello/agent stdout JSON-only；
- protocol fixture 和 error code 完整；
- secrets/credential/path redaction；
- package exports 只暴露批准的子路径；
- 全仓旧符号搜索为空。

## 15. 主要风险和处理

### 15.1 进程边界增加延迟

stdio JSONL 和 process spawn 会增加启动成本。处理方式：

- request response 只传小 DTO；
- delta 按 4 KiB/50 ms 合并；
- Server runtime lazy-load model/skills；
- TUI 首屏只等待 initialize 和 thread summary，不等待 provider catalog；
- 不因为性能重新引入 in-process fallback；若性能不足，优化 transport 和启动缓存。

### 15.2 多进程同时操作同一 thread

每个 thread 使用 lock/lease；第二个 Server 尝试 resume active thread 时返回 threadBusy。SQLite 使用 WAL 处理不同 thread 并发，JSONL writer 只允许持有 thread lock 的 Server 写入。

### 15.3 reconnect 时的事件空洞

不依赖内存 cursor。thread/resume 在同一 lock 内生成 snapshot、注册 subscription、重发 pending request；Client 发现 seq gap 就重新获取 snapshot。snapshot 之后的通知必须排队到 resume response 完成。

### 15.4 审批响应送错客户端

pending request 记录 controller connection 和 thread/turn/item。Server 只接受具备 approve capability、且当前持有 controller lease 的 response；失效 response 返回 requestResolved 或 permissionDenied。

### 15.5 远程路径和本地路径混淆

所有 thread/file path 都是 Server path。Client 显示时根据 Server 返回的 cwd 计算相对路径；需要把内容写到本地时，使用显式 --output，不把 Server path 当成本地可写路径。

### 15.6 旧 session 数据损坏

新 Server 不解析旧目录，避免在核心启动路径加入模糊兼容。通过独立 importer、备份和明确诊断处理，不在运行时 silently repair。

### 15.7 Server 过度膨胀

AgentServer、ThreadManager、ThreadRuntime、TurnController、projection、method handlers 分文件实现；每个文件设置约 500 行目标。新增能力必须放到对应 domain/agent/server module，不继续扩张中心协调器。

## 16. 完成定义

同时满足以下条件才算完成：

1. 仓库只剩 @ello/agent 和 @ello/tui 两个产品包。
2. @ello/agent 可以在没有 TUI import 的情况下独立启动 ello-agent Server。
3. @ello/tui 的默认 TUI/CLI 通过 stdio Client 访问独立 Server 子进程。
4. --remote 的 WebSocket/Unix 路径与本地 stdio 使用同一个 protocol/request processor。
5. Server 拥有 provider key、config、permission、workspace、tool、storage 和 memory 生命周期。
6. Client 不执行模型、工具、shell、文件写入或权限判断。
7. Thread 身份不可变；同一 thread mutation 串行、不同 thread 可并行。
8. Thread/Turn/Item notification 和 snapshot 足以恢复 timeline。
9. 审批、plan、用户输入均使用 Server Request，且断线可恢复或明确取消。
10. Server restart 对未完成 turn 有明确 interrupted 状态，不伪造成功。
11. 旧 CodingSession、旧事件 union、旧 envelope 和旧 v3 parser 已删除。
12. 无 in-process fallback、无旧协议 fallback、无 silent compatibility branch。
13. protocol v1 schema、package exports、import boundary 和真实进程 E2E 全部通过。

## 17. 参考实现对照表

| Codex 参考                                          | Ello 计划中的对应物                          | 采用方式                                      |
| --------------------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| docs/codex-appserver-api.md Protocol/Initialization | src/protocol/v1 + initialize gate            | 采用双向 JSON-RPC 和严格握手                  |
| Codex Thread/Turn/Item                              | domain Thread/Turn/Item + ThreadRuntime      | 采用资源层级，重命名 Ello 内部 run/step       |
| app-server/src/message_processor.rs                 | server/rpc/processor.ts                      | 采用 typed dispatch 和 connection-local state |
| app-server/src/transport.rs                         | server/transport/\*                          | 采用独立 outbound queue 和慢连接隔离          |
| app-server/src/outgoing_message.rs                  | server/connection/pending-server-requests.ts | 采用 Server Request callback map              |
| app-server/src/thread_state.rs                      | server/runtime/ThreadManager + ThreadEntry   | 采用 per-thread listener/serialization        |
| app-server-client                                   | @ello/tui/src/api                            | 采用 typed facade、request map、event stream  |
| tui/src/app_server_session.rs                       | ThreadClient                                 | 采用把 RPC plumbing 移出 UI 的做法            |
| Codex in-process client                             | 无对应物                                     | 明确删除，保证真正 Client-Server              |

实现时优先阅读上述文件的职责和测试，不直接复制 Codex 的 account、plugin、marketplace、realtime 或 review 全部 API。

## 18. 明确不做

- 不把 ello-agent 保持成可被任意应用直接调用的通用 SDK。
- 不在 ello-tui 内重新实现模型循环、工具执行或权限策略。
- 不保留 @ello/coding-agent 作为过渡 package 或 re-export alias。
- 不保留旧 session.\* wire command、CodingSessionEvent 或 approval.respond。
- 不把旧 session JSONL 的兼容解析放进 Server startup。
- 不用 Client 侧 cursor/replay buffer 替代持久化 snapshot。
- 不在第一版做共享多租户 Server；多租户需要独立 principal/process/container。
- 不让浏览器、TUI 或 Android 持有 provider credential。
- 不复制 Codex 全量 API，只实现与 Ello 当前功能对应的最小稳定面。
- 不为了隐藏重构风险而新增 fallback、compat、legacy、deprecated 双实现。
