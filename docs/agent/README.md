# Agent 模块

`@ello/agent` 是独立 App Server，持有 Thread、模型调用、工具执行、权限和存储。`@ello/tui` 通过 JSON-RPC 使用这些能力。

模块文章：

- [Client/Server 架构](client-server-architecture.md)：为什么从同构 TypeScript 拆成 C/S、进程边界、transport、握手、消息顺序保证。
- [Agent 与回合循环](agent-loop.md)：`create_agent` 抽象、`stream` 和 `run` 的区别、回合循环的设计、消息队列的设计、停止条件、事件流与背压。
- [Thread 运行时与事件日志](thread-runtime-and-event-log.md)：ThreadManager、lease、mutation queue、JSONL 事实源、三层投影和 fork 语义。
- [模型输入、工具与恢复](model-input-tool-loop-and-resume.md)：system prompt 拼接、model tools vs execution tools、审批产生的第二个 Engine run、deferred 工具约束和错误恢复。

主要源码：

- `packages/ello-agent/src/server`
- `packages/ello-agent/src/server/runtime`
- `packages/ello-agent/src/agent/engine`
- `packages/ello-agent/src/agent/execution/agent-turn-executor.ts`
- `packages/ello-tui/src/api`
- `packages/ello-tui/src/client`
