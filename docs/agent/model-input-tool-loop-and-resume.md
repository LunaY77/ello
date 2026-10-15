---
title: '模型输入、Command Run 循环与恢复'
description: '说明 Agent 如何构造唯一 command_run Tool、保持 outer transcript 配对，并通过 checkpoint 恢复审批和 deferred Command。'
---

# 模型输入、Command Run 循环与恢复

## 模型输入

每个模型回合由 `buildModelInput(run)` 组装 system、messages、tools、provider options
和 diagnostics。system prompt 由稳定规则与运行时动态上下文组成；消息依次经过 token
预算裁剪和 `preserveToolCallPairs`；最终输入再计算 fingerprint 与 token 诊断。

模型工具集合固定为：

```text
{ command_run }
```

`RunState` 从 `CommandRunRuntime.modelTool` 构造 AI SDK ToolSet。核心 Command、Ello
领域能力和 MCP 能力均不直接注册给 provider，因此 Agent、workspace 或 MCP 配置变化不会
改变 provider 的工具名称集合。`prepare` 钩子可以改写 model input，但生产执行仍会拒绝
任何不合法的 provider Tool 调用。

## Outer transcript

一次模型响应最多产生一个 outer `command_run` call。Agent engine 把完整 input 交给
`CommandRunRuntime.start()`；内部 Command 完成后，只为 outer call 生成一个 outer result：

```text
assistant: command_run call
tool:      command_run result
```

内部 `read`、`bash`、`command_invoke` 等 Command 有自己的 `commandRunId`、`commandId`、事件
和 Thread 记录，但不会生成合成 provider Tool Call。这样 OpenAI Responses、OpenAI Chat、
Anthropic 和 OpenAI-compatible 始终读取合法且相同的 call/result 结构。

`preserveToolCallPairs` 同时用于常规裁剪和 compaction：完整 outer pair 一起保留；孤立 call
或 result 一起移除。该处理只修复上下文窗口边界，不制造缺失的内部调用。

## 全批编译与执行

`CommandRunRuntime.start()` 在任何副作用前完成：

1. 严格解析 outer schema 与所有 Command Frame；
2. 检查大小、未知字段、`step` 顺序以及 `input` 与 `args/body` 互斥；
3. 从当前 Command Catalog 解析准确名称并生成类型化输入；
4. 建立稳定 Command identity、input digest 和 Scheduling Phase。

任一 Frame 编译失败时，整个 Command Run 返回带 frame index、command 和 usage 的失败结果，
前面的合法 Frame 也不会运行。编译通过后，不同 `step` 是严格 phase 屏障；同 phase 的兼容
只读 Command 可以并发，写入、Shell、外部状态和未知 Effect 通过 Environment Gate 串行化。

默认语义是 step 级失败屏障。同 step 的 immediate Command 相互独立，一个失败或拒绝不会阻止
同 step 的后续 wave；step 完成后才阻断后续 step。`onFailure: 'continue'` 让执行失败不建立
后续屏障，但不能覆盖拒绝或中断；`onFailure: 'diagnose'` 只允许在 runtime 证明安全只读时越过
已有屏障执行诊断。不自动回滚已经完成的文件、进程或外部副作用。

## 审批与 checkpoint

每个 phase 启动前会解析其中每条 Command 的动态 capability、validation 和 approval。
只要 phase 中存在待审批 Command，整个 phase 尚不启动。审批绑定：

- `commandRunId` 与 `commandId`；
- 类型化 input digest；
- logical capability 与权限 metadata；
- Command Catalog revision。

Runtime 返回 `suspended` transition，其中包含 durable `CommandRunCheckpoint` 和待处理
interaction。Agent 把 checkpoint 放入 deferred queue，Thread 层先持久化 Command Run
状态，再向 Client 发布 approval Server Request。

Client 返回决定后，Agent engine 调用 `CommandRunRuntime.resume()`。恢复直接使用 checkpoint
中的 compiled frames 和已完成结果，不重新解析模型原文，也不重放完成前缀。catalog revision
变化会使 checkpoint 失效；路径、文件版本、session mode、权限等动态条件会在真正执行前再次
验证。拒绝不影响同 step 的独立兄弟，但会在该 step 完成后生成 barrier 和后续 blocked 记录。

## Deferred Command

`request_user_input` 等宿主完成的能力经 `command_invoke` 进入 Deferred Command。运行到该 Command
时，runtime 保留已完成前缀、持久化 checkpoint、阻断尾部 Frame，并结束当前 Engine run。
宿主结果恢复同一个 outer Command Run；完成后的 outer result 进入下一模型回合，所以模型
只能在看到用户答案后生成依赖答案的新 Command。

审批和 deferred 暂停期间不会产生不完整 outer result。一个 Turn 可以串联多个 Engine run，
但 provider transcript 仍只有一个 outer call/result 对。

## 中断、steer 与崩溃

- 中断停止启动新 Command，并用 `AbortSignal` 取消可中断的在途工作；
- steer 不改写正在进行的 provider 请求，在下一模型回合进入消息队列；
- 进程恢复时，持久记录中的 running Command 标记为 `interrupted`；
- 有副作用的 in-flight Command 不自动重放，下一模型回合根据事实源决定是否重试。

源码入口：

- `packages/ello-agent/src/features/agent/engine/model-input.ts`
- `packages/ello-agent/src/features/agent/engine/tools.ts`
- `packages/ello-agent/src/features/agent/engine/run-control.ts`
- `packages/ello-agent/src/features/command/runtime.ts`
- `packages/ello-agent/src/features/thread/run-records.ts`
