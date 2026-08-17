# Subagent 导航与运行视图设计

## 1. 目标与边界

Ello 使用中心化的 Primary/Subagent 架构。Primary 可以异步创建多个相互独立的 Subagent，
但 Subagent 不具备任何 Agent control Command，不能递归 spawn、list、get、wait 或 stop 其它
Subagent。TUI 中的 Agent 列表因此是扁平列表，不是任务树。

用户可以进入任一 Subagent 的详情视图，并在它仍为 `running` 时直接发送 steer。这个用户交互
能力不等于递归委派能力：steer 只改变当前 Subagent 的运行输入，不授予它 Agent control
Command。

TUI 提供三个相互配合的表面：

- 主视图中的 `SubagentActivity`：展示有界运行轨迹和终态结果摘要；
- footer 下方的 `AgentSwitcher`：展示 `main` 与 Subagent 列表，提供导航和停止入口；
- Subagent 详情中的 transcript：已提交事件进入 shell scrollback，运行增量留在有界 live
  viewport。

三者共享 Agent Server 的公开投影。TUI 不能读取 `AgentTaskService`、数据库或底层 run 句柄。

## 2. 屏幕信息架构

```text
shell scrollback
  main committed history 或当前 Subagent committed transcript

live viewport
  main 当前流式内容 或当前 Subagent reasoning/running tool

bottom dock
  overlay
  composer
  footer
    model
    mode / context
    cache / token usage
  agent switcher
```

Agent switcher 必须位于完整 footer 之后。默认态不显示进入 Agent 列表的常驻方向提示。
overlay 打开时列表可以继续显示，但不接收按键。

## 3. Agent 列表导航

### 3.1 从 Composer 进入列表

`↓` 按以下优先级处理：

1. 有补全候选时移动候选；
2. 光标下方仍有 composer 视觉行时移动到下一行；
3. 光标位于最后一个视觉行且存在 Subagent 时，把焦点交给 Agent switcher；
4. 没有 Subagent 时保留输入历史行为。

进入列表不会清空草稿或改变光标。当前查看 `main` 时默认高亮第一个 Subagent；当前查看
Subagent 时默认高亮该实例。

### 3.2 选择态

```text
  ● main
❯ ○ explore  定位取消入口        running · 24s · 1.1k tokens
  ○ verify   运行测试            completed · 31s · 4.2k tokens
```

| 按键           | 行为                                             |
| -------------- | ------------------------------------------------ |
| `↑` / `↓`      | 按稳定创建顺序移动，首尾不循环                   |
| `Home` / `End` | 移到 `main` 或最后一个可见 Subagent              |
| `Enter`        | 查看选中 Agent；选中 `main` 时返回主视图         |
| `x`            | 停止选中的 `queued/running` Subagent             |
| `Esc`          | 退出选择态并恢复 composer 焦点，不中断任何 Agent |

选择态提示只在获得列表焦点后显示。活动 Subagent 显示 `Enter to view · x to stop`；`main` 和
终态 Subagent 只显示 `Enter to view`。

列表最多展示 `AGENT_SWITCHER_MAX_TASK_ROWS` 个 Subagent，超出时显示 `… +N more`。窗口以
高亮项为中心移动，任务状态、usage 或 elapsed 更新不得改变排序和高亮 ID。

## 4. 主视图运行摘要

### 4.1 运行态

```text
● explore(阅读 Subagent 架构)
  ⎿ Read(packages/ello-agent/src/features/agent/subagents/task-service.ts)
     Bash(pnpm --filter @ello/agent test)
     Running...
     … +2 tool uses
```

- 标题为 `<agent>(<description>)`；description 为空时只显示 Agent 名称；
- 最多展示最近 4 个不同 `toolCallId`，running tool 必须包含在窗口内；
- tool delta、重放和状态更新不能重复增加工具计数；
- 工具输出、diff 和长参数不进入摘要；
- usage 未知时不显示 `0 tokens`。

### 4.2 终态

```text
● explore(阅读 Subagent 架构)
  ⎿ Done (26 tool uses · 60.9k tokens · 3m 26s)
     任务生命周期由 AgentTaskService 管理。
```

终态为 `completed | failed | blocked | stopped`。结果预览来自 Server 投影的结构化
`resultPreview`，最多 480 字符和 3 个终端视觉行。`blocked` 与 `stopped` 和 `completed` 一样
优先展示结构化摘要；只有没有 result preview 时才回退到 error preview。

同一 Subagent 在主视图中只能有一份摘要：`queued/running` 位于 live viewport，终态到达后
从 live 区移除并按稳定 ID 写入 committed history。

## 5. Subagent 详情

详情的 Static header 展示 Agent 名称、definition、description、cwd、Task Packet objective 和
scope；当前状态单独留在动态区，避免状态变化后 scrollback 残留旧值。详情采用和主界面相同的
history/live 分层：

- `messageCompleted`、`reasoningCompleted`、已完成工具和用户 steer 进入 Ink `Static`，写入
  shell scrollback；
- live reasoning 和 running tool 进入 `LiveViewport`，使用 `liveViewportRows()` 的统一预算；
- 动态状态行计入 live viewport 总预算；
- 切换 Agent 视图前清理 terminal scrollback，再按当前 active path 重放；
- 成功结果的 `<agent-result>` JSON envelope 不直接显示，改为结构化 status、summary、
  evidence、risk 或 blocking question；
- 解析失败时允许展示有界原始输出，作为明确的诊断信息。

这样既保留完整已提交过程，也保证 dynamic frame 在可支持的终端尺寸下始终小于终端高度。

## 6. 直接与 Subagent 交互

运行中的 Subagent 详情页继续使用主 composer：

- composer 明确显示 `Steer @<name>`；
- `Enter` 通过 `agent/task/steer` 发送输入；
- steer 使用幂等 ID，断线重放不能重复应用；
- `queued` 或终态 Subagent 不接受 steer；
- `Esc` 返回 `main`，不停止 Subagent；
- Subagent 仍然看不到 Agent control Commands，因此用户 steer 不能触发递归 spawn。

## 7. 停止与中断

### 7.1 停止单个 Subagent

Agent 列表中的 `x` 调用一次 `agent/task/stop`。Server 只停止选中的实例：

- `queued/running` 收口为 `stopped`；
- 取消该实例尚未解决的审批或用户问题；
- 中断仍存在的 Agent run；
- 已经终态的实例保持不变；
- 晚到事件不能修改已提交终态。

因为 Subagent 不能递归 spawn，这里没有“停止子树”语义。

### 7.2 Root 中断

主 Turn 运行期间，无论当前查看 `main` 还是 Subagent，`Ctrl+C` 都调用一次 Server root
cancellation：中断 main Turn，并停止该 Primary 创建的全部活动 Subagent。TUI 不循环调用
多个 `agent/task/stop`。

## 8. 状态与指标

公开状态闭合为：

```text
queued | running | completed | failed | blocked | stopped
```

- elapsed 由 TUI 根据持久时间戳计算，Server 不发送每秒心跳；
- token 为 input 与 output token 之和；未知时省略；
- full 宽度显示状态、elapsed 和 token；narrow 隐藏 token；compact 只保留名称与状态；
- 状态必须显示文字，不能只依赖颜色。

## 9. Server 公开投影

TUI 使用以下 typed JSON-RPC 方法：

| 方法                     | 返回内容                                  |
| ------------------------ | ----------------------------------------- |
| `agent/task/subscribe`   | 建立订阅并返回无空窗 snapshot barrier     |
| `agent/task/unsubscribe` | 释放 connection 的 root 订阅              |
| `agent/task/list`        | Primary 创建的扁平 Agent snapshot         |
| `agent/task/read`        | 单个 Subagent 的 detail 和完整 event 序列 |
| `agent/task/steer`       | 向 running Subagent 追加幂等输入          |
| `agent/task/stop`        | 停止单个 Subagent                         |

列表摘要包含稳定 ID、definition、description、status、cwd、usage、最近 4 个 tool、结构化结果
预览和时间戳，不包含 Primary prompt、permission rules、sidechain 或运行句柄。

root sequence、task revision 或 event sequence 出现缺口时，Client 必须重新 subscribe/read，并
刷新或删除过期 detail cache。TUI 投影与 Primary completion notification 是两个独立消费通道。

## 10. 焦点优先级

```text
server request / approval
  > overlay
  > composer suggestion
  > agent switcher
  > composer editing
  > global shortcuts
```

`Composer` 与 `AgentSwitcher` 共享单一 focus owner，不能分别注册互相竞争的全局输入处理。

## 11. 验收标准

- Agent switcher 位于 footer cache/token 行之后，默认不显示导航提示；
- 列表扁平、有界、顺序稳定，终态仍显示 elapsed 和 token；
- `↓`、`↑`、`Enter`、`x`、`Esc` 与 `Ctrl+C` 符合本文合同；
- running 摘要最多展示 4 个 tool，终态结果最多展示 3 个视觉行；
- `blocked/stopped` 展示结构化 result preview；
- 用户能进入 running Subagent 并直接 steer，终态拒绝 steer；
- committed transcript 进入 shell scrollback，live 增量服从行数预算；
- 成功 `<agent-result>` envelope 不直接显示，结构化结果完整可读；
- sequence gap 后 snapshot 与 detail cache 恢复一致；
- 40、60、80、120 列屏幕测试不出现 footer 覆盖或可避免的整屏重绘。
