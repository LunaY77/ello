# Interactions — 跨组件联动设计

> 组件不是孤岛:ello 的事件流(JSON-RPC 事件 + 变更事件 + 审批请求)驱动多个组件同时变化。本文档定义联动的触发源、受影响组件、动画与一致性规则,作为各组件文档之上的全局契约。

## 联动总表

| # | 触发 | 源组件 | 受影响组件 | 联动行为 |
| --- | --- | --- | --- | --- |
| L1 | 审批请求到达 | approval | session-sidebar / app-shell / chat-timeline | 队列卡滑入;侧栏会话行与工作区行亮 `◐` warning 点;顶栏状态徽标变"待审批";不在前台发系统通知 |
| L2 | 审批被处理 | approval | session-sidebar / chat-timeline / 顶栏 | 卡片收起;时间线插入系统事件行;状态点回落(无其他待审批项时) |
| L3 | 工具执行步骤更新 | tool-call | file-explorer / diff-viewer / 变更计数 | 编辑步骤完成 → 文件树对应行出现变更标记;变更页签计数 +1;diff 内容增量刷新 |
| L4 | 点击工具卡编辑步骤 | tool-call | file-explorer / diff-viewer | 文件树定位该文件(展开祖先目录 + 行高亮),diff 定位到对应 hunk,目标行 1s 脉冲 |
| L5 | 选中工作区 | session-sidebar | file-explorer / diff-viewer / task-board / composer | 右栏三页签整体切换到该 Workspace 上下文;composer ControlBar 的工作目录同步;顶栏面包屑更新 |
| L6 | 打开其他工作区的会话 | session-sidebar(会话区) | 全局 | 当前工作区上下文顺带切换到该会话所属工作区(同 L5) |
| L7 | 会话模式切换 | composer / command-palette / 顶栏 chip | chat-timeline / approval | 三处入口状态同步;时间线插入系统事件行;新模式生效后对应类别的审批卡不再到达 |
| L8 | Plan 审批到达 | plan-mode | approval / session-sidebar | 计划卡同时出现在时间线与审批队列;侧栏聚合状态点亮;批准 → 模式 chip 切 `ask-before-changes`(触发 L7) |
| L9 | 任务板变更 | task-board | session-sidebar / chat-timeline | 任务状态变化由 Agent 工具驱动;进行中任务数反映到会话行副行;任务提问 → 时间线追问消息高亮联动 |
| L10 | 点击任务卡 | task-board | chat-timeline | 时间线滚动到该任务最近的关联消息,消息 1s 高亮脉冲 |
| L11 | Agent 写入文件进行中 | 文件变更事件 | file-explorer / tool-call | 树行尾写入动画;Inspector 对应步骤行呼吸点;完成后动画变变更标记(L3) |
| L12 | 连接断开/重连 | 传输层 | 全局 | 顶栏状态徽标变"重连中";composer 禁用;各面板数据冻结(保留最后快照,不置空);恢复后事件流补播,各组件按事件顺序收敛 |
| L13 | 主题切换 | settings / command-palette | 全局 | 全部 CSS 变量原子切换,无闪烁;Acrylic 材质参数同步;图片类内容(diff 截图除外)不受影响 |
| L14 | `$skill` 激活 | composer | skills / tool-call | 激活作为工具调用出现在 Inspector;skills 详情页"本会话已激活"徽标即时更新 |
| L15 | 归档工作区 | session-sidebar | 全局 | 其下会话保留但工作区 tag 加"已归档"灰徽标;当前上下文若是该工作区则退出到"全部上下文" |

## 设计规则

### R1 单一事实源,事件驱动

所有联动由 ello Server 的事件流驱动,组件间**不直接通信**。UI 层的 zustand store 订阅事件并投影成各组件消费的切片;一个事件到达,多个切片原子更新。禁止"组件 A 调组件 B 的方法"式的横向联动 — 联动路径永远是 `事件 → store → 各组件`。

### R2 状态聚合上冒

子级状态向父级聚合,规则统一:`运行中 > 待审批 > 失败 > 空闲`。
- 会话行状态 = 该 Thread 当前状态。
- 工作区行状态 = 其内所有会话状态的聚合(取最高优先级)。
- 顶栏徽标 = 当前工作区上下文的聚合。
任何一级点击都能 drill 到具体来源(点工作区行 → 会话区滚动到聚合来源的会话)。

### R3 定位脉冲

一切"跳转定位"联动(L4/L10)的终点反馈统一:目标滚动进视口(平滑,`--duration-slow`)+ 目标行/卡片 1s 背景脉冲(`fluent-subtle` 淡入淡出两次)。脉冲是全应用唯一的"你到了"信号,不再设计第二种。

### R4 并发与打断

- 多个联动同时触发(如审批到达时正在切工作区):动画可打断,状态不可丢 — 动画从头播放,数据以事件流最终状态为准。
- 用户正在阅读 diff 时收到 L3 增量:内容在用户视口外更新,视口内不动,顶部出现"有新变更"浮动条,点击才刷新 — 永远不抽走用户正在看的内容。

### R5 离线与重连(L12)

断连时所有联动冻结但不清空:每个面板保留最后已知状态 + 顶部"数据可能不是最新"细条;重连后事件流补播,组件按事件序收敛到最新,期间不闪动。

### R6 联动的键盘可达

每条联动都有键盘等效:L4 = Inspector 内 `Enter`;L10 = 任务卡 `Enter`;L5 = `Cmd+1..9` 直选工作区。hover 才出现的联动入口必须同时进命令面板。

## 时序示例:L1 审批到达

```
Server ──permission.asked──▶ store
  ├─▶ approval slice      → 队列卡从 composer 上方滑入(--duration-base)
  ├─▶ sidebar slice       → 会话行 + 工作区行状态点 → ◐(150ms 颜色过渡)
  ├─▶ topbar slice        → 徽标 "待审批 · 1"
  └─▶ 前台? ─否─▶ Tauri 系统通知(标题 = 工具 + 操作一句话)
用户点击"允许一次"
  ├─▶ approval slice      → 卡片 150ms 收起
  ├─▶ timeline slice      → 插入系统事件行 "✓ 已允许运行 pnpm test(仅本次)"
  └─▶ sidebar/topbar      → 队列空则状态点回落
```
