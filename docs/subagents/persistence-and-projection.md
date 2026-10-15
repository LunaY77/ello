# Subagent 持久化与公开投影

## 1. Drizzle 存储约束

SQLite 通过 `CodingDatabase` 访问，`schema.ts` 声明 `agentTasks` 和
`agentTaskNotifications`。`AgentTaskStore` 的 CRUD、状态迁移、事件和通知统一使用 Drizzle
的 `insert`、`select`、`update`、`delete` 与 `immediateTransaction`，不得访问
`database.$client` 或拼接业务 SQL。

统一使用 typed Drizzle schema 避免以下风险：

- schema 改名时 TypeScript 无法提示 SQL 字符串；
- insert/update 列与 Drizzle schema 可能漂移；
- 需要额外维护一套 snake_case Zod row parser；
- 普通事务与 `immediateTransaction` 策略不一致；
- code review 无法从类型上确认 JSON 列、nullable 字段和返回值。

Drizzle schema 是任务数据库结构的唯一入口。事务统一通过
`immediateTransaction()` 管理，Service 不拼接原生 SQLite 事务。

## 2. Store 分层

```text
AgentTaskService
  └─ AgentTaskStore
       ├─ task CRUD and state transitions
       ├─ append-only transcript events and root sequence
       └─ parent-model notification queue
                  ↓
          CodingDatabase + Drizzle schema
```

Store 使用组合门面 `AgentTaskStore`，并在门面内按 task、event/root sequence 和 notification
三组操作维护各自不变量。公开协议投影由 `task-projection.ts` 负责，大工具结果分流由
`event-artifacts.ts` 负责，Store 不承担 UI 渲染。

领域类型放在独立 `task-types.ts`；Drizzle row 到领域对象的转换集中在 Store 边界。JSON
字段继续在读取时做 Zod 校验，但不再解析一套手写 `select *` row schema。

## 3. Drizzle 查询约束

正常 CRUD 使用以下形式：

```ts
db.insert(agentTasks).values(row).run();

db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).get();

db.update(agentTasks)
  .set({ status: 'running', startedAt: now, updatedAt: now })
  .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'queued')))
  .run();
```

按 selector 查询使用 `eq` / `and` / `or`，按创建时间排序使用 `asc`。禁止 `select *` 和依赖
参数位置的长 `.run(a, b, c...)`。

`markRunning` 必须以 `queued` 为条件执行单条 update，并检查 `changes`，保证多调用方只能有
一个 claim 成功。

## 4. 事务边界

以下复合写必须使用仓库已有的 `immediateTransaction(db, tx => ...)`：

- task 从 running/queued 进入终态，同时创建唯一完成通知；
- 批量标记通知 delivered；
- 创建 resume task，同时写入 resume 血缘初始事件；
- foreground 转 background，同时写入 delivery mode 事件；
- 追加 transcript event，同时推进 task revision/current tool/usage projection；
- 追加工具事件，同时更新 `tool_count` 和最多 4 项 `recent_tools_json`；
- task 进入终态，同时生成有界 result/error preview；
- task 子树或 root 级联取消，同时建立 cancellation barrier；
- 推进 root thread 级连续序号并写入对应公开事件；
- Server 启动时把遗留 running task 收口为 recovered。

终态写入采用条件 update：

```text
where id = ? and status in (queued, running)
```

如果 changes 为 0，事务内重新读取并返回既有终态，实现幂等。notification 通过 taskId 唯一
索引和 Drizzle `onConflictDoNothing()` 保证只创建一次。

普通只读或单行 insert 不需要手动事务。不能为了方便在 Service 中跨多个 repository 临时
拼 `$client.transaction()`；事务所有权属于 Store 门面。

## 5. 数据模型

### 5.1 `agent_tasks`

任务表保存运行参数和结果，关键字段包括：

- `parent_thread_id` 重命名语义为 `root_thread_id`；
- `parent_task_id` 只表示嵌套父 task；
- 新增 `resume_from_task_id`；
- status 增加 `recovered`；
- 新增 `description`，避免 TUI 从 prompt 猜摘要；
- 将旧 `mode` 拆成 `context_mode` 与 `execution_mode`；
- 新增 `revision`，每次可见投影更新单调递增；
- 可选 `current_tool_json` 只保存列表所需摘要，不保存完整输出。
- 新增 `tool_count`，按唯一 toolCallId 累计，delta 和重放不能重复增加；
- 新增 `recent_tools_json`，只保存最近 4 项有界调用摘要；
- 新增 `result_preview` 与 `error_preview`，只保存主视图所需的有界文本。

JSON 列保存 sidechain、tool names、permission rules、external paths 和 usage。每一列都有独立
Zod schema，解析失败应报告 taskId 与列名，不能把损坏数据默认为空数组。

task 不再持久化一套独立生效的 child permission mode。工具调用通过 `root_thread_id` 读取
root Thread 当前 SessionMode；事件记录当次判定使用的 mode，保证权限审计可还原。

### 5.2 `agent_task_roots`

每个 root thread 保存一个连续 `sequence`。任何会改变公开 Agent 树或 child transcript 的
事务先推进该值，再把相同 root sequence 写入公开事件。它用于 TUI 发现整棵树的通知缺口；
单 task revision 只能发现已知 task 的更新缺口，不能发现一个 task 的创建通知完全丢失。

root sequence 的读取与更新必须处于 immediate transaction。若 Drizzle/SQLite 版本支持
`update ... returning`，优先使用 typed returning；否则在事务内 select + update，并把唯一的
SQLite 限制封装在数据库 helper，而不是散落到 Agent repository。

### 5.3 `agent_task_events`

child transcript 不能只依赖最终 sidechain。新增 append-only event 表：

```text
root_thread_id
task_id
sequence
root_sequence
event_type
payload_json
created_at
```

主键为 `(task_id, sequence)`，`(root_thread_id, root_sequence)` 另有唯一索引。事件覆盖
message、reasoning、tool start/delta/complete、steer、usage、status 和 error。task sequence
在单 task 内严格连续，root sequence 在整棵树上严格连续。

序列化工具结果超过 32 KiB 时，完整内容写入 ArtifactStore；event payload 只保存 4 KiB
preview、artifactId、artifactBytes、contentType 和截断标记，避免 SQLite 与 RPC 无界膨胀。

### 5.4 `agent_task_notifications`

该表只服务父模型的完成结果投递：

- taskId 唯一，确保一个 task 只有一条终态通知；
- `payload_json` 保存 summary、result、usage；
- `delivered_at` 只在消息已加入父模型上下文后写入；
- TUI 读取或进入 child 不得更新 deliveredAt。

UI 实时更新来自 `agent_task_events` 和 task projection，不复用 notification delivery queue。

## 6. 公开读模型

Repository 不直接把数据库 row 暴露给协议。Server 组装两种 projection：

```text
AgentTaskSummary  -> 列表与 composer 下 switcher
AgentTaskDetail   -> header、完整 transcript、结果和错误
```

summary 不包含 prompt、permission rules、sidechain 或完整输出，只包含状态、说明、关系、usage、
最近 4 个工具摘要、toolCount、有界 result/error preview 和时间。detail 通过显式 rootThreadId
校验 task 归属，不能跨 root thread 读取。
`agent/task/subscribe` 必须原子建立 connection subscription 并返回带 root seq 的完整
snapshot barrier；不得先 list 再另行 subscribe 留下竞态窗口。

有界字段由 Server projection 层统一生成：

- `recentTools` 每项只含 toolCallId、name、单行 invocation preview、状态和时间；
- `resultPreview` 取最终 assistant 消息，最多 480 字符；
- `errorPreview` 取用户可见错误，不包含 stack、原始 provider payload 或内部路径；
- TUI 再按终端宽度裁成最多 3 个视觉行，但不能重新选择另一段内容作为第二套摘要；
- 完整 output、错误详情和工具结果仍保存在 detail/event/artifact。

公开 API 与通知设计见
[Subagent 导航与运行视图设计](../tui/subagent-navigation-and-runtime.md#7-server-公开投影)。

## 7. 恢复语义

Server 初始化时在 immediate transaction 中把遗留 `running` 标为 `recovered`，写入恢复事件
和确定错误原因。恢复不自动 launch，因为原进程的工具副作用是否完成未知。

显式 resume：

1. 读取并校验来源 task 属于当前 root thread；
2. 确认来源为 terminal/recovered；
3. 创建新 taskId 和 agentId；
4. 复制允许继承的 sidechain 与运行边界；
5. 写入 `resumeFromTaskId`，保留原 `parentTaskId`；
6. 启动新 run。

原 task 永不回到 queued/running，也不覆盖原 output。

## 8. 验证覆盖

- Drizzle schema 与 migration snapshot 一致；
- Store 测试不得直接依赖 SQL 列名或 `$client.prepare()`；
- create/get/list 支持 taskId、agentId 和 thread-local name；
- 两次并发 claim 只有一次成功；
- settle 与 notification 在同一事务提交或一起回滚；
- settle、stop、deliver 重复调用保持幂等；
- task stop 递归收口活动后代，root interrupt 收口 main 之外的全部活动 task；
- cancellation barrier 建立后拒绝同一子树或 root 创建新 task；
- event sequence 严格连续，缺口读取失败；
- JSON 数据损坏时显式失败并带定位信息；
- restart 把 running 收口为 recovered；
- resume 同时保持 parent 层级和 resume 血缘；
- TUI read model 不泄漏 permission rules、完整 prompt 或内部 run 句柄。
- toolCount 按 toolCallId 去重，recentTools 永不超过 4 项；
- result/error preview 满足字符上限且与完整 detail 内容来源一致。

验证必须执行 Drizzle Kit schema 检查、新数据库迁移契约测试和源码边界检查。schema 检查
应返回 `No schema changes, nothing to migrate`，并且
`rg '\$client' packages/ello-agent/src/features/agent/subagents` 必须无命中。
