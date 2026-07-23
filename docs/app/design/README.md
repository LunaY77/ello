# ello-app 设计稿总览

ello-app 是 ello Agent 的客户端(Tauri 2 + React 19 + TypeScript + Tailwind CSS + Zustand),视觉体系遵循 [fluent-design.md](fluent-design.md),工程结构见 [前端技术架构与编码规范](../frontend-architecture.md)。本目录按组件拆分设计稿,每个组件一个文件夹,内含设计文档与明暗效果图。

代码审查记录见 [ello-app code review](../ello-app-code-review.md),Server 端待办见 [ello-agent server tasks](../ello-agent-server-tasks.md)。组件 README 描述设计目标；PNG 仅用于视觉评审,不作为实现契约。

## 设计来源与取舍

设计稿参考了四个产品的 UI/UX,取其经过验证的决策,统一收敛到 Fluent 视觉语言:

| 来源       | 借鉴的决策                                                                                                                               | 用在                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Tokenicode | 三面板布局、思考/写入/工具三阶段执行反馈、`Cmd+K` 命令面板、结构化审批卡片、会话置顶/归档/撤销删除、子代理状态监控                       | app-shell、chat-timeline、command-palette、approval、session-sidebar |
| lobe-chat  | 用户有气泡 / 助手无气泡的不对称消息流、hover 才浮现的分级消息操作条、右侧 WorkingSidebar 页签栏、设置整页路由、单色默认主题              | chat-timeline、file-explorer、settings                               |
| open-webui | 灰阶 + 黑白反转发送键、代码块"sticky 顶栏 + 内容 + 执行结果"三段式卡片                                                                   | composer、tool-call                                                  |
| tura       | RunSummary 胶囊 + 可拖宽 Tool Inspector 的二级信息架构、审批作为 composer 上方常驻队列而非弹窗、半透明色块 diff、看板 + 状态灯任务可视化 | tool-call、approval、diff-viewer、task-board                         |

不借鉴的部分:lobe-chat 的emoji 反应与 TTS、open-webui 的多模型对比滑动、Tokenicode 的品牌与文案。Fluent 规则(材质边界、动效时长、阴影层级)一律以 [fluent-design.md](fluent-design.md) 为准。

## 与 ello 域模型的对应

组件不是纯视觉设计,每个都对应 ello 的协议概念:

| ello 概念                                                       | 承载组件                                |
| --------------------------------------------------------------- | --------------------------------------- |
| 会话模式 `ask-before-changes / accept-edits / plan / bypass`    | composer(模式切换)、app-shell(模式标识) |
| 审批四操作 `Allow once / Allow for this thread / Deny / Cancel` | approval                                |
| Plan 审批 `Accept / Chat about this / Deny`                     | plan-mode                               |
| Task board(状态、owner、依赖)                                   | task-board                              |
| 工具调用与执行结果                                              | tool-call                               |
| Thread / 会话                                                   | session-sidebar、chat-timeline          |

## 组件地图

| 文件夹                                       | 组件       | 一句话定位                                                         |
| -------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| [app-shell](app-shell/README.md)             | 应用骨架   | 三栏布局 + Acrylic 顶栏 + 窗口布局                                |
| [session-sidebar](session-sidebar/README.md) | 侧栏双区   | 工作区 / 会话两区各自按时间倒序,类型色块、状态聚合、hover 行内操作 |
| [chat-timeline](chat-timeline/README.md)     | 消息时间线 | 不对称气泡、三阶段执行反馈、hover 分级操作条                       |
| [tool-call](tool-call/README.md)             | 工具调用   | RunSummary 胶囊 + Tool Inspector 检查器                            |
| [approval](approval/README.md)               | 权限审批   | composer 上方常驻审批队列 + 审批卡片                               |
| [plan-mode](plan-mode/README.md)             | Plan 模式  | 计划预览卡与 Accept / Chat about this / Deny                       |
| [composer](composer/README.md)               | 输入区     | 四层结构、斜杠命令、模式切换、发送/停止                            |
| [file-explorer](file-explorer/README.md)     | 文件面板   | WorkingSidebar 页签、文件树、变更标记                              |
| [diff-viewer](diff-viewer/README.md)         | Diff 视图  | 半透明色块 diff、统计头、批量应用                                  |
| [command-palette](command-palette/README.md) | 命令面板   | `Cmd+K` Acrylic 浮层、分组命令、快捷键                             |
| [task-board](task-board/README.md)           | 任务板     | 看板列 + 状态灯 + 依赖连线                                         |
| [settings](settings/README.md)               | 设置       | 整页路由、分类导航、主题预览卡                                     |
| [skills](skills/README.md)                   | 技能管理   | 两层目录、覆盖关系、hash 版本、错误暴露                            |
| [interactions](interactions/README.md)       | 跨组件联动 | 事件驱动的联动总表与全局规则                                       |

## 明暗双主题

所有组件同时提供浅色 / 深色两套实现,token 取值见 [fluent-design.md](fluent-design.md) §2(同名 token,亮暗不同值)。规则:

- **零硬编码色值**:组件只引用 token,主题切换 = CSS 变量原子切换,无闪烁、无重排。
- **每个组件文件夹提供 `design.png`(浅色)与 `design-dark.png`(深色)两张效果图**,两者布局完全一致,仅主题不同 — 评审时成对检查。
- 暗色特有调整:Acrylic tint 加深、阴影权重降低(暗色下以 border 分层为主)、diff 色块透明度上调 4%、kind 色块亮度上调保持可辨。
- 语义色(success/warning/danger)亮暗两套都须配合图标 + 文字,不单独依赖颜色。

## 全局交互约定

- **安静默认**:一切操作入口(消息操作、行内按钮、元信息)默认隐藏,hover/focus 以 `--duration-fast` 淡入;键盘 `Tab` 可达。
- **二级信息架构**:主时间线只放结论与摘要(胶囊、卡片头),细节永远收进可展开区或右侧面板,时间线不允许被工具输出刷屏。
- **不弹窗原则**:审批、追问等高频打断用 composer 上方的常驻队列承载;模态只用于低频、不可逆操作(删除、清空)。
- **颜色即状态**:品牌蓝 `#0078D4` 只表达"可交互/进行中",语义色必须图标 + 文字双编码(见 fluent-design.md §2)。
- **键盘可达**:每个组件文档列出快捷键;所有 hover 操作必须有等效键盘路径。
