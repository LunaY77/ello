# Subagent 导航与运行视图设计

## 1. 目标与边界

Subagent 不能只表现为一次 `delegate_to_subagent` 工具调用。用户需要在主 Agent 中看到
child 正在做什么，也需要在底部快速选择、查看或停止任一 child。

本设计把能力拆成三个独立表面：

- 主视图中的 `SubagentActivity`：展示单个 child 的运行工具、状态和结果预览；
- footer 下方的 `AgentSwitcher`：展示 `main` 与 child 列表，并提供导航和停止入口；
- child 详情中的 `AgentTranscript`：展示完整消息、推理、工具事件和错误。

三者共享 Agent Server 的任务投影，不各自维护一套任务状态。TUI 只能使用公开协议，不能
读取 `AgentTaskService` 的内存对象、数据库连接或底层 run 句柄。

工具轨迹展开快捷键不属于本设计范围。主视图只提供有界摘要，完整过程通过 `Enter` 进入
child 详情查看，界面中不显示展开提示。

## 2. 屏幕信息架构

Agent 列表属于 bottom dock，但必须放在完整 footer 之后。`primary / auxiliary`、会话模式、
context、cache 和 token 行先稳定渲染，Agent 列表最后渲染：

```text
shell scrollback / 已完成历史

live viewport / 当前流式内容与 SubagentActivity

bottom dock
  overlay
  composer
  footer
    primary / auxiliary
    mode / context
    cache / token usage
  agent switcher
```

默认态示例：

```text
┌──────────────────────────────────────────────────────────────────────┐
│ > 修复认证测试中的并发问题                                          │
└──────────────────────────────────────────────────────────────────────┘
 primary: deepseek-v4-pro · auxiliary: deepseek-v4-flash
 bypass context 9.9k / 1.0m · 99% left
 99% cached · 59 uncached

  ● main
  ○ explore  定位取消链路入口                 running · 18s · 610 tokens
```

Agent 列表不能插到 composer 与 footer 之间，也不能把 cache 行挤到列表下方。默认态不显示
任何用于进入 Agent 列表的常驻方向提示。

overlay 打开时 Agent 列表可以继续显示，但不接收按键。审批、用户问题、设置和候选列表拥有
更高的输入优先级。

## 3. Composer 与 Agent 列表导航

### 3.1 从 Composer 进入列表

`↓` 同时承担多行编辑和进入 Agent 列表的职责，按以下优先级处理：

1. 有补全候选时，移动补全候选；
2. 光标下方仍有 composer 视觉行时，移动到下一视觉行；
3. 光标位于最后一逻辑行的最后一个视觉行且存在 child 时，把焦点交给 Agent 列表；
4. 没有 child 时，保留既有输入历史行为，不进入只有 `main` 的列表。

进入列表不会清空草稿，也不会改变 composer 光标。当前视图为 `main` 时，首次进入默认高亮
第一个 child；当前正在查看 child 时，默认高亮该 child。只有列表焦点态显示选择光标。

composer 的 `←` / `→` 始终只负责文本光标，不再承担进入 Agent 列表的隐藏语义。

### 3.2 选择态

```text
 primary: deepseek-v4-pro · auxiliary: deepseek-v4-flash
 bypass context 9.9k / 1.0m · 99% left
 99% cached · 59 uncached
 Enter to view · x to stop

  ● main
❯ ○ explore  定位取消链路入口                 running · 24s · 1.1k tokens
  ○ verify   运行认证模块测试                 queued
```

符号表达视图和选择状态，不表达任务生命周期：

| 符号 | 含义                              |
| ---- | --------------------------------- |
| `●`  | 当前正在查看的 Agent              |
| `○`  | 当前未查看的 Agent                |
| `❯`  | 键盘选择光标，可以与 `●` 同时出现 |

选择态按键：

| 按键           | 行为                                           |
| -------------- | ---------------------------------------------- |
| `↑` / `↓`      | 按稳定顺序移动，首尾不循环                     |
| `Home` / `End` | 移到 `main` 或最后一行                         |
| `Enter`        | 查看选中 Agent；选中 `main` 时返回主视图       |
| `x`            | 停止选中的 queued/running child 及其活动后代   |
| `Esc`          | 退出选择态并恢复 composer 焦点，不中断任何任务 |

当高亮项是 `main` 或已经终态的 child 时，提示只显示 `Enter to view`，`x` 不产生请求。发送停止
请求后，该行进入本地 `stopping` 控制态，禁用重复按键；Server 确认后显示持久状态 `killed`。

任务状态、usage 或 elapsed 更新不得改变列表排序和高亮 taskId。新增任务追加到稳定位置；已选
任务结束后保留该行，用户仍可进入查看结果。

## 4. 主视图中的运行摘要

`SubagentActivity` 是主 Agent 历史和 live viewport 中的委派摘要，不承担导航。它通过
`taskId` 关联任务投影，运行时展示 child 的最近工具调用和当前状态。

### 4.1 运行态

```text
● explore(阅读 ello-agent 的 Subagent 架构)
  ⎿ Read(packages/ello-agent/src/features/agent/subagents/task-service.ts)
     Read(packages/ello-agent/src/features/agent/subagents/task-store.ts)
     Bash(pnpm --filter @ello/agent test ...)
     Running...
     … +2 tool uses
```

颜色只用于建立层级，不把整张摘要染成同一种状态色：

| 元素                       | 语义 token                       | 视觉目的                       |
| -------------------------- | -------------------------------- | ------------------------------ |
| `●` 状态点                 | running=`warning`，queued=`info` | 一眼识别生命周期，避免整行发黄 |
| Agent 名称                 | `accent` + bold                  | 作为摘要的稳定视觉锚点         |
| description                | `text`                           | 可读但不与 Agent 名称争夺焦点  |
| `⎿` 轨迹引导符             | `borderActive`                   | 串联轨迹层级，不模拟错误或警告 |
| 工具名称                   | `info`                           | 与参数形成清晰的扫描边界       |
| 工具参数、隐藏计数和指标   | `textMuted`                      | 降低命令、路径和统计信息的噪声 |
| `Running...` / `Queued...` | 对应状态色                       | 仅给真正变化的状态文字着色     |
| 最终结果预览               | `text`                           | 保持正文对比度，不使用灰色弱化 |

状态色必须保持克制：标题不能整行使用 `warning` / `success` / `error`。完成态只让状态点和
`Done` 使用 `success`，失败态只让状态点和 `Failed` 使用 `error`，停止与 recovered 使用
`warning`。终态指标继续使用 `textMuted`，因此长 token 和耗时不会压过最终结果。

展示规则：

- 标题固定为 `<agent>(<description>)`，description 为空时只显示 Agent 名称；
- 每次工具调用只占一个视觉行，复用统一 tool card presenter 生成 headline；
- 工具输出、diff 和长参数不进入摘要，命令与路径按终端宽度截断；
- 最多展示最近 4 次不同的工具调用，当前 running tool 必须包含在这 4 次内；
- 总调用数超过上限时显示 `… +N tool uses`，`N` 是未展示的调用数；
- `Running...` 单独占一行，不把不断变化的流式参数扩展成多行动态区域；
- usage 尚未产生时省略 token，不显示误导性的 `0 tokens`。

工具计数按唯一 `toolCallId` 计算。tool delta、重试渲染和断线重放不能重复增加计数。

### 4.2 完成态与结果预览

完成后，运行摘要原位收口并只提交一次静态历史：

```text
● explore(阅读 ello-agent 的 Subagent 架构)
  ⎿ Done (26 tool uses · 60.9k tokens · 3m 26s)
     任务生命周期由 AgentTaskService 管理，持久状态由 AgentTaskStore 保存。
     TUI 通过独立任务投影订阅运行事件，不直接读取 Server 内存状态。
     …
```

完成态沿用相同层级：Agent 名保持 `accent`，`Done` 为 `success`，括号内 metrics 为
`textMuted`，三行结果预览使用 `text`。失败与停止只替换状态点和状态词的语义色，不改变正文
颜色，保证四套内置主题下都有一致的信息权重。

结果预览使用 child 最终 assistant 消息，而不是工具输出、通知 XML 或内部错误对象：

- 去掉首尾空白和空段落，保留可读的纯文本内容；
- 最多显示 3 个终端视觉行，同时设置 480 字符硬上限；
- 超出任一上限时在最后一行追加 `…`；
- 最终消息为空时只显示 `Done (...)`；
- 完整消息保存在 task detail，进入 child 详情后可查看；
- notification 到达和 task terminal event 重复时，以 taskId 和终态 revision 去重。

`tool uses` 取任务累计工具调用数；token 取 input 与 output 的总和；耗时取
`completedAt - startedAt`。缺失的指标直接省略，不补零。

失败和停止使用同一结构：

```text
● verify(运行认证测试)
  ⎿ Failed (8 tool uses · 42s)
     测试进程退出码为 1，失败位置为 auth/session.test.ts。

● explore(检查取消链路)
  ⎿ Stopped (3 tool uses · 12s)
```

失败预览使用对用户可见的错误摘要；停止不展示内部 abort stack。

### 4.3 Live 与 History 交接

同一 task 在主视图中只能有一个摘要实例：

- queued/running 位于 live viewport；
- terminal revision 到达时，从 live viewport 移除并追加一条 committed history；
- history replay 直接读取持久终态摘要，不重新播放每个 tool delta；
- 断线恢复以 Server projection 为准，不把恢复前后两段合并成两张摘要。

## 5. Agent 列表行

每个 Agent 固定占一行：

```text
[view/name] [description................] [status · elapsed · tokens]
```

- `main` 始终排在第一行，child 按创建顺序稳定排列；
- 状态文字统一为 `queued`、`running`、`completed`、`failed`、`killed`、`recovered`；
- `recovered` 表示 Server 重启后原 run 已消失，必须显式 resume；
- elapsed 由 TUI 根据持久时间戳计算，Server 不发送每秒心跳；
- token 未知时省略，不显示 `0 tokens`；
- completed child 至少保留到当前主 Turn 结束，避免完成瞬间从列表消失。

行内 description 只做单行末尾截断。状态不能只靠颜色表达。

## 6. Child 详情视图

进入 child 后，活动视图切换为 task transcript：

```ts
type ActiveAgentView =
  | { kind: 'main'; threadId: string }
  | { kind: 'task'; rootThreadId: string; taskId: string };
```

该状态只属于 TUI，不改变 task 的 foreground/background 调度模式。详情视图复用主界面的
history、reasoning、tool card 和 live viewport：

- header 展示 Agent、description、cwd、context/execution mode 和父任务；
- committed message 与 live delta 分开渲染；
- token、tool count 和 elapsed 只使用当前 task 的 usage；
- 完整工具输入、输出 preview 和 diff 从 task detail event 生成；
- `Esc` 返回父 Agent；一级 child 返回 `main`，不停止任务。

运行中的 child 可以通过 composer 提交 steer，目标必须显示为 `@<name>`。终态 child 不接受
steer；resume 创建新 task，并通过 `resumeFromTaskId` 记录血缘。

详情内不提供 compact/expanded 切换。工具轨迹按 transcript 规则渲染；展开能力需要单独
定义按键冲突和持久状态，不纳入本设计。

## 7. 停止与中断

### 7.1 `x` 停止单个任务树

Agent 列表中的 `x` 调用一次 `agent/task/stop`。停止语义由 Server 定义为“选中 task 子树”：

1. 先为目标 task 建立 cancellation barrier，拒绝它继续创建 child；
2. 将目标及所有 queued/running 后代收口为 `killed`；
3. 取消这些任务正在等待的审批和用户问题；
4. 中断仍存在的 AgentRun；
5. 保留 completed/failed/recovered 等既有终态，不回写历史结果。

TUI 不遍历列表逐个 stop，否则会在并发创建 child 时留下孤儿任务。重复 `x` 和晚到的完成
事件必须幂等，不能让 `completed` 覆盖已经提交的 `killed`。

### 7.2 `Ctrl+C` 中断整棵运行树

主 Turn 运行期间，无论当前查看 `main` 还是 child，`Ctrl+C` 都表示中断 root execution：

- 中断主 Agent 当前 Turn；
- 停止该 root Thread 下所有 queued/running Subagent；
- 递归停止每个 Subagent 的活动后代；
- 取消整棵树尚未解决的审批、用户问题和 foreground delivery gate；
- 等待 Server 返回级联停止结果后再把 TUI 标记为空闲。

Server 必须提供一个 root 级取消协调入口。TUI 只发送一次中断请求，不能先中断 main 再循环
调用 `agent/task/stop`。Server 先建立 root cancellation barrier，再处理主 run 与 child run，
确保取消过程中不能产生新的漏网任务。

`Esc` 在 child 详情中只返回父视图；在 main 运行视图触发 Turn 中断时，与 `Ctrl+C` 使用同一
root 级联取消语义。空闲状态下仍保留“清空草稿 / 退出”的既有 `Ctrl+C` 行为。

## 8. 权限交互

Subagent 的有效会话模式来自 root Thread，与主 Agent 在每次工具调用时读取同一模式源：

- root 为 `bypass` 时，child 不得产生工具审批；
- root 为 `accept-edits` 时，child 的编辑自动执行，Shell 等仍按该模式处理；
- root 为 `ask-before-changes` 时，需要审批的 child 工具请求交给 root connection；
- root 为 `plan` 时，child 继续受只读边界限制。

Agent definition 的工具白名单和 hard deny 只能缩小能力，不能扩大 root Thread 的权限。
权限模式与审批路由是两个概念，不能再用 `bubble` 一类字段同时表达两者。

只有当前模式确实返回 `ask` 时才展示审批面板。面板必须显示 Agent 名称、工具、description
和 cwd。`bypass` 下出现 child 审批属于权限继承错误，不是正常交互。

完整规则见[Subagent 权限与工具边界](../subagents/permission-isolation.md)。

## 9. Server 公开投影

TUI 使用以下公开方法：

| 方法                     | 返回内容                                              |
| ------------------------ | ----------------------------------------------------- |
| `agent/task/subscribe`   | 建立 root 订阅并返回 Agent 树 snapshot barrier        |
| `agent/task/unsubscribe` | 释放当前 connection 的 root 订阅                      |
| `agent/task/list`        | root 下的 Agent 树与有界摘要                          |
| `agent/task/read`        | 单个 task 的完整 detail、transcript 和 event sequence |
| `agent/task/steer`       | 向 running task 追加带幂等 ID 的指令                  |
| `agent/task/stop`        | 停止一个 task 子树                                    |
| `agent/task/resume`      | 从 terminal/recovered task 创建新 task                |
| `agent/task/background`  | 将 foreground task 单向转为 background                |

列表和主视图摘要需要以下有界字段：

```ts
interface AgentTaskToolSummary {
  toolCallId: string;
  name: string;
  invocationPreview: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
}

interface AgentTaskSummary {
  taskId: string;
  agentId: string;
  rootThreadId: string;
  parentTaskId?: string;
  resumeFromTaskId?: string;
  name?: string;
  definitionName: string;
  description: string;
  contextMode: 'fresh' | 'fork';
  executionMode: 'foreground' | 'background';
  status:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'killed'
    | 'recovered';
  cwd: string;
  isolation: 'shared' | 'worktree' | 'container';
  revision: number;
  eventSequence: number;
  toolCount: number;
  recentTools: AgentTaskToolSummary[];
  resultPreview?: string;
  errorPreview?: string;
  usage?: Usage;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}
```

`recentTools` 最多保存最近 4 项，`resultPreview` / `errorPreview` 是 Server 生成的有界协议字段，
不是 TUI 从完整 output 临时截断出的第二套事实。完整 prompt、permission rules、sidechain、
output 和工具结果仍只存在于 detail 或 artifact 中。

task event 至少覆盖 message、reasoning、tool started/completed、usage、steer、status 和 error。
root `seq`、task `revision` 或 event `sequence` 出现缺口时，TUI 重新 subscribe/read；不能靠本地
计数猜测工具数量或终态。

父模型 notification queue 与 TUI task projection 是不同消费通道。TUI 显示结果预览不得把
父模型通知提前标记为 delivered。

## 10. 焦点优先级

按键由单一 focus owner 分发：

```text
server request / approval
  > overlay
  > composer suggestion
  > agent switcher
  > child transcript action
  > composer editing
  > global shortcuts
```

`Composer` 和 `AgentSwitcher` 不能各自注册互相竞争的常驻 `useInput()`。建议状态为：

```ts
type AgentInputFocus = 'composer' | 'agent-switcher';
```

焦点切换只改变按键归属，不改变任务状态。`Ctrl+C` 是运行态的 root 级全局命令，必须在焦点
路由中高于普通 composer 清空逻辑。

## 11. 窄终端布局

- Agent 列表始终位于 footer 最后一行之后，任何宽度下都不与 cache 行并排；
- Agent 行固定一行，description 使用终端字符宽度做末尾截断；
- 空间不足时依次隐藏 token、elapsed 和 description，最后保留名称与状态；
- 主视图工具摘要每个 tool 固定一行，Bash 多行命令折叠空白后截断；
- 结果预览按视觉行裁剪，中文宽度不能使用 JavaScript 字符串长度估算；
- 40 列下选择提示允许单独占一行，但不能覆盖 Agent 行。

## 12. 验收标准

### 12.1 布局与导航

- Agent 列表出现在 cache/token footer 行下方；
- 默认态不显示进入 Agent 列表的常驻方向提示；
- composer 光标位于最后一个视觉行时按 `↓` 进入列表，草稿和光标不丢失；
- 多行中间位置与补全候选仍优先消费 `↓`；
- `↑` / `↓` 稳定选择，`Enter` 切换视图，`Esc` 返回 composer；
- running child 被选中时显示 `Enter to view · x to stop`；
- 不显示工具展开提示。

### 12.2 运行摘要

- running 摘要最多展示 4 个不同 tool call，并正确显示 `… +N tool uses`；
- 断线重放和 tool delta 不重复计数；
- completed 摘要显示 Done、tool count、token、elapsed 和最多 3 行结果预览；
- 完成摘要只进入主历史一次，完整结果可在 child detail 查看；
- usage 未知时不显示 `0 tokens`。

### 12.3 权限与停止

- root 为 `bypass` 时，fresh/fork、foreground/background child 均不产生工具审批；
- 其他模式与主 Agent 使用同一动态模式源，definition 只能收紧能力；
- `x` 只停止高亮 child 子树，不影响无关 sibling 和 main；
- `Ctrl+C` 中断 main Turn，并停止 root 下全部 queued/running child 及后代；
- 取消期间新建 task 被 barrier 拒绝，晚到完成事件不能覆盖 `killed`；
- pending approval、用户问题和 foreground delivery gate 随所属任务一起收口。

### 12.4 测试矩阵

| 层级         | 必测内容                                                        |
| ------------ | --------------------------------------------------------------- |
| protocol     | 有界 recentTools/resultPreview、strict schema、序号缺口         |
| Agent Server | 动态模式继承、bypass、单 task 子树停止、root 级联取消、竞态幂等 |
| client       | snapshot/event reducer、结果去重、重连、跨 Thread 隔离          |
| TUI store    | `↓` 焦点状态机、稳定排序、`x`、`Ctrl+C` 全局优先级              |
| component    | footer 后列表、工具上限、完成预览、中文换行和宽窄终端           |
| integration  | main/child 切换、并行 child、审批模式切换、取消期间创建 child   |

验收必须包含自动化测试和 120、80、60、40 列真实 PTY 验证，并以本文交互合同逐项检查。
