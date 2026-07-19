# ello 中文技术文档

文档以当前工作树中的源码为依据，按功能模块分目录。每篇文章从"为什么要这样做"开始，再讲"怎么做"和"具体实现"。

| 模块       | 入口                                               | 主要内容                                                   |
| ---------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Agent      | [agent/README.md](agent/README.md)                 | C/S 架构、Agent 抽象与回合循环、Thread runtime、工具与恢复 |
| Compact    | [compact/README.md](compact/README.md)             | 请求级裁剪、Thread checkpoint、触发时机、提示词与边界      |
| Prompt     | [prompt/README.md](prompt/README.md)               | 系统提示装配、上下文来源、Provider cache                   |
| Memory     | [memory/README.md](memory/README.md)               | 文件契约、仓储一致性、索引注入与后台任务                   |
| Task       | [task/README.md](task/README.md)                   | 任务拆分、状态依赖、使用入口与实现边界                     |
| Goal       | [goal/README.md](goal/README.md)                   | 持久目标的使用方式、生命周期、用量结算与实现边界           |
| Plan       | [plan/README.md](plan/README.md)                   | Plan artifact、hash 校验、审批与模式切换                   |
| Subagents  | [subagents/README.md](subagents/README.md)         | 注册表、覆盖顺序、权限派生、后台 job                       |
| Skills     | [skills/README.md](skills/README.md)               | 加载、安全校验、索引预算和激活去重                         |
| Permission | [permission/README.md](permission/README.md)       | 模式选择、审批操作、持久规则与工作区外路径                 |
| Workspace  | [workspace/README.md](workspace/README.md)         | 多仓库任务目录、分支、参考仓库、归档与修复                 |
| TUI        | [tui/README.md](tui/README.md)                     | 启动、输入与命令、会话模式、上下文和恢复                   |
| Protocol   | [protocol/README.md](protocol/README.md)           | JSON-RPC 边界、握手、能力与 transport                      |
| Storage    | [storage/README.md](storage/README.md)             | JSONL 事实源、SQLite 投影、artifact 与 usage               |
| Config     | [config/README.md](config/README.md)               | 首次配置、作用域、模型服务与常见排错                       |
| Tools      | [tools/tool-scheduler.md](tools/tool-scheduler.md) | 工具调度边界、审批与恢复，以及单个编码工具的执行语义       |

建议先读 [Agent 与回合循环](agent/agent-loop.md) 和 [Agent C/S 架构](agent/client-server-architecture.md)。这两篇覆盖核心抽象、进程边界和消息驱动方式。
