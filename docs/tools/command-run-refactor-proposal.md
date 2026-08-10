---
title: 'Command Run 重构'
description: 'Ello 将全部模型能力收敛到 command_run 后的最终协议、运行时、恢复、事件和提示体系。'
status: implemented
date: 2026-08-04
---

# Command Run 重构

> 状态：**Implemented**。本文记录已经进入生产路径的架构；ADR-0002 至 ADR-0007 是对应
> 决策记录，`features/command` 是运行时事实来源。

## 1. 最终结构

任意 coding Agent 只向 provider 暴露一个 Tool：`command_run`。所有环境执行、MCP、Memory、
Skill、Goal、Task、Subagent 和用户输入能力都通过 Command Run 请求，同时保留各领域不同的
执行、权限和暂停语义。

```text
Model
  |
  | one provider-visible tool
  v
command_run
  |
  +-- Core Commands: read / search / write / apply_patch / bash
  +-- Discovery Commands: command_search / command_invoke
  |                            |
  |                            +-- MCP / Memory / Skill / Goal / Task / Subagent
  +-- Deferred Commands: request_user_input / host-completed capabilities
```

Command Run 是深模块，不是旧执行器外的一层 wrapper。它拥有 Frame 编译、Scheduling Phase、
Environment Gate、逐 Command 审批、fail-fast、Diagnostic Command、checkpoint、恢复、事件和
结果归一化。Agent engine 只依赖 `CommandRunRuntime.start/resume`。

相关决定：

- [ADR-0002：分帧 CLI 协议](../adr/0002-framed-cli-command-protocol.md)
- [ADR-0003：默认快速失败且不自动回滚](../adr/0003-command-run-failure-semantics.md)
- [ADR-0004：Command 独立授权并以 step 为暂停边界](../adr/0004-command-approval-and-resume.md)
- [ADR-0005：step 表达阶段而运行时拥有安全调度](../adr/0005-runtime-owned-command-scheduling.md)
- [ADR-0006：核心执行能力作为内部 Command 提供](../adr/0006-internal-command-catalog.md)
- [ADR-0007：所有模型能力通过 Command Run 请求](../adr/0007-all-model-capabilities-through-command-run.md)

ADR-0001 已被 ADR-0007 取代。

## 2. Provider 协议

```ts
interface CommandRunInput {
  readonly commands: readonly CommandFrame[];
}

interface CommandFrame {
  readonly step: number;
  readonly command: string;
  readonly args?: readonly string[];
  readonly body?: string;
  readonly input?: Readonly<Record<string, JsonValue>>;
  readonly onFailure?: 'stop' | 'diagnose' | 'continue';
}
```

协议约束已经固化在严格 Zod schema 中：

- 每次 1 至 32 个 Frame，总输入不超过 1 MiB；
- `step` 是正整数并按输入顺序非递减；
- `args` 最多 128 项，单个 `body` 不超过 256 KiB；
- `input` 与 `args/body` 互斥，v1 只给 `command_invoke`；
- 未知字段、别名、fenced JSON、倒序 step 和猜测性修复均失败；
- 一次 provider 响应最多包含一个 outer `command_run` call。

核心 Command 使用 `args + body`。`command_invoke` 使用结构化 `input` 保留任意 nested
object/array schema，不经过 JSON-in-string 或 Shell 二次分词。

```json
{
  "commands": [
    { "step": 1, "command": "read", "args": ["src/app.ts"] },
    {
      "step": 1,
      "command": "search",
      "args": ["text", "createCommandRunRuntime", "--path", "src"]
    },
    {
      "step": 2,
      "command": "apply_patch",
      "body": "*** Begin Patch\n...\n*** End Patch"
    },
    { "step": 3, "command": "bash", "body": "pnpm test" }
  ]
}
```

Provider adapter 只处理各厂商的 outer Tool wire protocol，不理解内部 Command。Transcript 只
保留一个 outer call 和一个 outer result；内部事件不会被合成为 provider Tool Call。
context 裁剪和 compaction 以完整 outer pair 为单位保留或移除。

## 3. Command Catalog

核心 Command：

| Command       | 实现语义                                                      |
| ------------- | ------------------------------------------------------------- |
| `read`        | 文件/目录读取、分页、附件、文件版本                           |
| `search`      | 统一 content search 与 file search                            |
| `write`       | 创建或整体替换、expected digest、变更预览与审计               |
| `apply_patch` | 严格 patch parse、预演、文件变更与 diff                       |
| `bash`        | Environment process、cwd、timeout、exit code、artifact 与取消 |

`edit` 由 `apply_patch` 覆盖，`grep/glob` 归入 `search`，测试通过 `bash` 执行。PTC 是
`write + bash` 运行本地 Python/Node/Shell 的范式，不存在 `ptc`、`run_program` 或脚本内
Tool API。

其他 Ello Tool 与 MCP Tool 进入能力目录。`command_search` 返回准确名称、描述、风险和完整
schema；`command_invoke` 按准确名称与结构化 arguments 复用目标的 schema、capability、validation、
approval 和 execute/deferred 定义。

三个入口不能被发现或递归代理：`command_run`、`command_search`、`command_invoke`。核心 backing tool
也不是 `command_invoke` target，所以写入、Shell 和 Plan mode 无法通过 wrapper 绕过。

## 4. 编译与调度

Runtime 在任何副作用前完成全批编译：outer schema、Frame codec、目标 lookup、领域 schema、
稳定 `commandRunId/commandId`、typed input digest 和 phase 分组。任一错误拒绝整个请求，并
返回 frame index、command 和准确 usage。

`step` 是严格 Scheduling Phase 屏障。同一 phase 内，runtime 根据真实 capability 和
Environment Gate 调度：兼容安全读取可并发；写入、Shell、外部状态、deferred 和未知 Effect
保守串行。runtime 可以增加串行化，但不能跨 phase 或重排可观察结果。

默认使用 step 级失败屏障：同 step 的 immediate Command 相互独立，一个失败或拒绝不会阻止
同 step 的后续 wave；step 完成后，普通后续 Frame 记录为 `blocked`。`onFailure: 'continue'`
让执行失败不建立后续阻断点，但不能覆盖拒绝或中断，整批仍为失败；只有显式
`onFailure: 'diagnose'` 且 runtime 证明只读、安全并发、非破坏的 Command 可以越过已有屏障。
Shell 非零退出默认失败；不自动回滚已经发生的副作用。

## 5. 审批、Deferred 与恢复

每个 phase 启动前准备全部 Command。只要存在待审批项，整个 phase 暂不启动；授权分别绑定
logical name、typed input digest、permission metadata、catalog revision、`commandRunId` 和
`commandId`，不批准整个 Command Run。

Runtime 在暂停时返回 `CommandRunCheckpoint`：

```ts
interface CommandRunCheckpoint {
  readonly schema: 1;
  readonly commandRunId: string;
  readonly providerToolCallId: string;
  readonly inputDigest: string;
  readonly catalogRevision: string;
  readonly compiledFrames: readonly CompiledCommandFrame[];
  readonly results: readonly CommandRecord[];
  readonly phaseCursor: number;
  readonly approvals: readonly CommandApprovalRecord[];
  readonly pendingCommandIds: readonly string[];
  readonly pendingKind: 'approval' | 'deferred';
}
```

Thread 在发布 Server Request 前持久化并 flush checkpoint。恢复不解析模型原文，不重放已完成
Command；catalog revision 变化会使 checkpoint 失效，动态路径、文件版本、session mode、
权限和 capability 在执行前重新验证。

`request_user_input` 等 Deferred Command 保留完成前缀、阻断尾部并暂停当前 Engine run。
外部结果恢复同一个 outer Command Run；完成结果进入下一模型回合，模型才能生成依赖答案的
新 Command。进程崩溃后，running Command 标记为 `interrupted`，有副作用的操作不自动重放。

## 6. Thread、Protocol 与 TUI

Command 事件携带稳定 `commandRunId` 与 `commandId`：

- `command_run.started/failed/suspended/completed`；
- `command.started/completed/failed/blocked`；
- `command.approval_required/deferred`。

Thread JSONL 是事实源，使用一个 `commandRun` item 保存有序 Command 行、checkpoint 和最终
状态。`command_invoke` 投影目标 logical name，而不是 wrapper 名。TUI live timeline 与 history
reload 使用相同协议记录，展示 Shell 输出、diff、审批、MCP/Memory/Skill/Subagent 语义及
blocked/denied/failed/interrupted 状态，不渲染无信息量的 outer Tool 卡片或嵌套卡片。

Agent 与 TUI 同步升级协议，TUI 只依赖 `@ello/agent/protocol`。

## 7. Prompt 策略

Direct 与 Balanced 共用同一 runtime、schema、Catalog、权限和 reasoning effort。差异只来自
生产 prompt composition：

| 策略     | 调查                   | Command Run                   | 完成判定                     |
| -------- | ---------------------- | ----------------------------- | ---------------------------- |
| Direct   | 最小充分证据，尽早行动 | 已知操作尽量一次批完          | 获得足以支撑结果的证据       |
| Balanced | 恢复完整路径与风险     | 调查、修改、验证按 phase 组织 | 完成 prompt-to-artifact 审计 |

共享 `backward-reasoning.md` 从期望结果反推约束与证据；共享 `command-run.md` 描述 Frame、
phase、失败诊断、PTC 和动态能力。反向推理不是 runtime mode 或隐藏 planner。

生产 prompt 位于 `packages/ello-agent/src/features/agent/context/prompts/`；设计来源见
[Command Run 提示词](command-run-prompts/README.md)。

## 8. 最终模块布局

```text
packages/ello-agent/src/features/command/
  index.ts       # public CommandRunRuntime seam
  types.ts       # Frame/result/event/checkpoint contracts
  schema.ts      # strict provider wire schema
  catalog.ts     # Catalog, codec, compiler, adapter, digest
  runtime.ts     # start/resume, phase scheduling, approval, recovery
```

复杂度被收进模块内部，外部 interface 保持 `modelTool`、`catalogRevision`、`start()` 和
`resume()`。Composition root 装入 Environment、权限、MCP、Memory、Skill、Goal、Task 与
Subagent capability；Agent engine 不导入 Command 内部实现。

## 9. 已删除体系

本次实施删除：

- provider Tool batch `ToolScheduler` 及其 execution gate；
- `createMetaToolRuntime` 与旧搜索索引；
- `logicalToolCall`、`projectToolMessages`、`projectToolEvent` wrapper 投影；
- `modelTools/executionTools/callableToolNames` 双集合；
- read/grep/glob/write/edit/apply_patch/bash/test 的直接模型暴露；
- `tools.routing_enabled` 配置、模板、设置 UI 和兼容分支；
- 旧直接 Tool prompt 与只覆盖浅层 scheduler 的测试。

继续复用 Environment filesystem/process 与 Gate、领域 Command schema/approval/execute、RulesStore、
permission policy、session mode、output store、file change、artifact、Thread JSONL、Server
Request、MCP manager 以及各领域模块。

## 10. 验证矩阵

实现的自动化验证覆盖：

- 严格 Frame、全批编译零副作用、phase barrier 与跨 Handle Environment Gate；
- fail-fast、diagnostic、denial、approval、resume、interrupt 和 deferred；
- `command_search/command_invoke` nested MCP schema 与 Memory/Skill/Goal/Task/Subagent 可达性；
- `write -> bash` PTC；
- outer replay pair、context compaction 与四类 provider wire contract；
- Thread checkpoint、进程 E2E、TUI live/history Command Run group；
- Plan mode 不可通过 `command_invoke` 绕过核心 Command。

全仓完成检查按 CI 顺序执行：

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @ello/agent verify-comments
pnpm --filter @ello/agent verify-dist
pnpm exec prettier --check .
git diff --check
```

真实 provider smoke 需要当前环境的生产凭证。Benchmark 只能使用健康、publishable 的新 run，
并记录 verifier success、provider round trips、token、结果字节、解析失败、wall time、审批和
恢复；不健康或 evidence 不完整的历史 run 仅用于诊断。

## 11. 实施结果

已确定并实施的局部选择：

1. `command_invoke` 使用结构化 `input`，ADR-0002 已接受该扩展；
2. `write` 使用 expected digest 进行乐观并发控制，并保留 diff/审计；
3. `bash` 非零退出默认使 Command 失败；
4. Thread/TUI 使用一个 `commandRun` group；
5. crash 后不自动重放 in-flight 有副作用 Command；
6. Direct/Balanced 仅分叉 prompt policy，不分叉 runtime。
