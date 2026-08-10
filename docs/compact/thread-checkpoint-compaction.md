# Thread Context Checkpoint

## 状态所有权

Thread Log 是 durable session/audit 的事实源。Provider Context 是从 Thread records 和当前
AgentRun 状态构造的有界投影，两者不是同一个数组或生命周期。

Context Checkpoint 追加一条 `compaction` record，声明旧 provider history 被一份 checkpoint
投影替代；旧 transcript records 继续保留，archive、export 和诊断仍能读取完整日志。

```text
durable transcript records
  + latest compaction(summary, firstKeptSeq)
  -> checkpoint message
  + transcript records with seq >= firstKeptSeq
  -> Provider Context
```

## 自动流程与执行连续性

自动 checkpoint 是同一 active AgentRun 内的同步控制流 transition，不是后台任务：

```text
drain current input
  -> publish and persist new transcript
  -> build current provider input
  -> evaluate/force checkpoint
  -> build checkpoint projection from the compaction strategy
  -> publish and persist compaction record
  -> rebuild Provider Context
  -> run admission
  -> call provider in the same AgentRun
```

`messages.appended` Engine event 在 user/steering 输入和每轮 assistant/tool transcript 产生时立即
发布。`context.compaction` 只能在此前消息事件之后发布。Thread consumer 因此可以把
`keptMessageCount` 映射为已经存在的 transcript seq，并写出 `firstKeptSeq`。

checkpoint commit 成功后，Agent loop 没有自然 stop 分支：它必须重建输入并进入本轮 provider
call。只有取消、checkpoint 写入失败或重建后仍超预算会阻止下一次 call。

## Checkpoint projection

当前 compactor 仍使用已有的 checkpoint 生成策略；新的宿主结构化 projection schema、字段优先级、
预算和跨 checkpoint 合并规则尚未确认，尚未进入生产装配。完整 Command output 位于 artifact，
近期 outer `command_run` call/result pair 仍需保持合法 replay。

## 触发与切点

自动模式按 `threshold_percent` 判断当前投影是否接近配置窗口；硬 admission 发现超限时还会
强制尝试一次 checkpoint，防止 provider 在自动阈值之前拒绝请求。

切点至少保留一条近期消息，并避免让 provider 尾部从孤立 tool result 开始：

1. 自动模式按 `preserve_recent_tokens` 从尾部寻找 user/assistant 边界。
2. force 模式优先保留 `tail_turns` 对应的近期 user turn。
3. 找不到合法边界或消息少于两条时返回 `null`。

## 持久 record

`compaction` record 的核心字段为：

| 字段 | 含义 |
| --- | --- |
| `summary` | checkpoint 内容；生成策略由当前 compactor 提供 |
| `firstKeptSeq` | 第一条继续原样 replay 的 transcript record seq |
| `tokensBefore` | checkpoint 前的估算输入量 |
| `beforeMessageCount` | checkpoint 前消息数 |
| `afterMessageCount` | checkpoint message 加近期尾部后的消息数 |
| `keptMessageCount` | 继续原样保留的近期消息数 |

运行内 `compactionId` 只关联 started/completed TUI events，不是 durable identity。当前设计不增加
独立 checkpoint id 或 `sourceThroughSeq`。

## 手动 `/compact`

手动入口要求 Thread idle，并同步等待 compactor 和 record append 完成。它不会在
active AgentRun 外启动后台 continuation，也不会把 Task Handoff 与 Context Checkpoint 合并。

## Replay 与 cache

checkpoint 后的 Provider Context 仍遵守 provider wire contract：

- 一个 outer `command_run` assistant call；
- 紧随其后的同 ID tool result；
- result 只包含有界 Command observation；
- call arguments 保留原始 outer input；
- result 不重复 Command input、digest、timestamp 或 TUI metadata。

稳定 system/tool schema 与未改变的 transcript prefix 保持 provider cache 的可复用性。checkpoint
会有意建立一个新的 prefix；它只在明确压缩 transition 时发生，不会像旧请求级 anchor 一样
每轮漂移。

## 失败语义

| 条件 | 结果 |
| --- | --- |
| checkpoint 不需要或没有合法切点 | 返回 `null`，继续 admission |
| checkpoint commit 成功且 run active | 重建并调用 provider |
| checkpoint 前后取消 | `interrupted`，不发新请求 |
| checkpoint/record 写入失败 | run 明确 `failed` |
| 重建后仍超过预算 | 明确 context budget error |

## 源码入口

- [`compact.ts`](../../packages/ello-agent/src/features/thread/compact.ts)
- [`run-state.ts`](../../packages/ello-agent/src/features/agent/engine/run-state.ts)
- [`agent.ts`](../../packages/ello-agent/src/features/agent/engine/agent.ts)
- [`run.ts`](../../packages/ello-agent/src/features/agent/run.ts)
- [`run-records.ts`](../../packages/ello-agent/src/features/thread/run-records.ts)
