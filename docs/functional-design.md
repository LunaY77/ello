# Ello 功能设计

本文档以重构前 `references/ello` 的代码、测试和配置为业务基线，描述重构后
`repos/ello` 必须持续满足的功能契约。目录结构、类名和私有函数可以调整；本文件中的
功能 ID、输入、可观察结果和异常语义属于稳定契约。对应测试见
[`test-design.md`](test-design.md)。

## 1. 阅读与维护约定

- `@ello/agent` 是唯一拥有模型、工具、权限、工作区、配置和持久化状态的 Server。
- `@ello/tui` 是纯 Client；它只持有连接状态和本地显示偏好，通过 JSON-RPC 使用业务能力。
- JSONL Thread Log 是会话事实源，SQLite Catalog 是查询投影；两者不得形成双写事实源。
- 表中的“结果”是调用方可观察的功能结果，不包含私有类、调用次数等实现细节。
- 新增、删除或改变功能时，必须同步修改本文件的功能契约和 `test-design.md` 的测试矩阵。
- 纯重命名或内部重排不应改变功能 ID；真正的破坏性变更必须在文档中明确迁移策略。

## 2. 业务模块总览

| 模块                    | 功能 ID              | 旧版来源                              | 重构后所有者                                     |
| ----------------------- | -------------------- | ------------------------------------- | ------------------------------------------------ |
| Agent 执行引擎          | `F-ENG-*`            | `ello-agent/core`                     | `@ello/agent/agent/engine`                       |
| 上下文与模型输入        | `F-CTX-*`            | `coding-agent/context`                | `@ello/agent/agent/context`                      |
| 工具与交互              | `F-TOL-*`            | `coding-agent/tools`、`user-input`    | `@ello/agent/agent/tools`、`server/interaction`  |
| 配置与模型目录          | `F-CFG-*`            | `coding-agent/config`、`provider`     | `@ello/agent/config`、`agent/providers`          |
| 权限与会话模式          | `F-PER-*`            | `coding-agent/permission`、`plan`     | `@ello/agent/agent/permissions`、`domain/thread` |
| Skill 与 Subagent       | `F-SKL-*`            | `coding-agent/skills`、`agents`       | `@ello/agent/agent/skills`、`subagents`          |
| Memory、Goal 与 Plan    | `F-MEM-*`、`F-GOL-*` | `coding-agent/memory`、`goal`、`plan` | `@ello/agent/agent`                              |
| Workspace 与 Repository | `F-WSP-*`            | `coding-agent/workspace`              | `@ello/agent/workspace`                          |
| 持久化与任务            | `F-STO-*`            | `coding-agent/storage`、`tasks`       | `@ello/agent/storage`                            |
| Thread 生命周期         | `F-THR-*`            | 旧 session runtime                    | `@ello/agent/domain`、`server/runtime`           |
| 协议与 RPC              | `F-RPC-*`            | 无（重构新增边界）                    | `@ello/agent/protocol`、`server/rpc`             |
| Transport 与进程        | `F-TRN-*`            | 旧进程内调用                          | `@ello/agent/server/transport`                   |
| Client 与连接恢复       | `F-CLT-*`            | 无（重构新增边界）                    | `@ello/tui/api`、`client`                        |
| CLI                     | `F-CLI-*`            | `coding-agent/cli`                    | `@ello/tui/cli`                                  |
| TUI 交互与展示          | `F-TUI-*`            | `coding-agent/tui`                    | `@ello/tui/tui`                                  |
| 可观测性与发布边界      | `F-OBS-*`、`F-REL-*` | 两个旧包的配置与构建                  | 两个新包各自所有                                 |

## 3. Agent 执行引擎

**设计目标：** 提供与 provider 无关、可流式消费、可恢复且有明确停止条件的多轮 Agent
循环。

**职责：** 构建模型调用、调度工具、维护本次 run 的消息队列、累计 usage、输出稳定事件和
最终结果。

**边界与依赖：** 依赖 `ModelAdapter`、`AgentEnvironment`、session/recorder 等 port；不依赖
JSON-RPC、SQLite、Ink 或具体 Server 连接。Server 通过 TurnExecutor 适配该引擎。

| ID         | 具体功能           | 输入                                              | 处理流程                                                                            | 预期结果                                                                      | 异常与边界行为                                                                                                  |
| ---------- | ------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `F-ENG-01` | 同步与流式运行     | Agent 配置、用户消息、可选临时指令与 abort signal | 建立 run snapshot，加载一次历史，逐 turn 调用 adapter；`run()` 消费同一条流式主路径 | `run()` 与 `stream.final` 返回同形结果；文本 delta 保持增量；临时指令不持久化 | stream 无 final、多 final、final 后仍有 delta 均失败；provider 原始错误不伪装为空结果；abort 得到 `interrupted` |
| `F-ENG-02` | 多轮工具循环       | 模型 tool-call、注册工具、`maxTurns`              | 校验唯一工具名和 schema，按 scheduler 执行，将 tool-call/result 追加到下一轮输入    | 工具事件 ID 稳定；工具结果进入后续模型轮；每轮只构建一次输入                  | 重名工具 fail fast；达到 `maxTurns` 停止；无新消息的工具轮以 `no-progress` 结束；未知工具形成明确失败结果       |
| `F-ENG-03` | 审批、延迟与恢复   | approval 决策、deferred tool、已持久化历史        | 未批准时不执行副作用；恢复时在原 tool-call 后追加匹配 result 并继续循环             | 单次批准执行一次；拒绝产生终态工具失败；deferred result 可恢复原 run          | 混合 deferred batch 在任何副作用前拒绝；approval adapter 抛错被规范化；不匹配或重复恢复直接失败                 |
| `F-ENG-04` | 队列、steer 与背压 | follow-up/steer 消息、慢事件消费者                | 按稳定优先级排空 control queue，将 steer 注入下一轮；事件流使用有界缓冲             | steer 不污染当前已发出的模型输入；正常慢消费者不丢事件                        | 未消费缓冲达到上限时 run 失败；停止后消息不再注入；第二次加载历史不得重复消息                                   |

## 4. 上下文与模型输入

**设计目标：** 把稳定 system 前缀、动态工作上下文和 provider cache 策略分离，使模型输入
可重复、可诊断且不会因动态内容破坏缓存。

**职责：** 加载指令源、Skill/Memory/Goal/Plan 片段，构建 run 级 snapshot，执行输入变换并
生成 cache fingerprint。

**边界与依赖：** 通过注入的文件/URL loader 读取来源；不直接控制模型循环，不拥有 Thread
持久化。动态源变化只影响当前或下一次 run snapshot。

| ID         | 具体功能             | 输入                                                 | 处理流程                                                                                                   | 预期结果                                                                                                      | 异常与边界行为                                                                                                   |
| ---------- | -------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `F-CTX-01` | 指令与上下文源装配   | cwd、配置的 glob/URL、Agent/Skill/Memory/Goal 状态   | 按固定顺序加载 source，规范化内容并生成诊断；同一 run 冻结 snapshot                                        | system prompt 与动态 source 分段稳定；未配置时不擅自注入 repository/git 内容                                  | 单一 run 内文件变化不可产生前后不一致；URL 刷新失败可使用标记为 stale 的过期缓存；无可用缓存时返回明确错误       |
| `F-CTX-02` | Provider cache 布局  | system sections、工具 schema、runtime model          | 分离稳定前缀和动态尾部，计算 instruction/toolset fingerprint，再应用 OpenAI/Anthropic 变换                 | 动态 Skill/上下文变化不破坏稳定前缀；工具契约变化一定改变 toolset key                                         | 动态段后再次出现稳定段属于非法布局；不同凭据或不兼容 provider 不共享 cache key                                   |
| `F-CTX-03` | 上下文预算与输出外置 | 历史、Shell 输出、token budget、手动 compaction 请求 | 按字符估算从最旧消息开始裁剪并修复 tool-call/result 配对；超大 Shell RPC 输出写入 Artifact，仅内联有界预览 | 下一轮模型输入不超过预算；完整 Shell 输出可通过 `artifact/read` 分块读取；未装配 compactor 时手动请求明确拒绝 | Artifact 缺失/损坏、offset 越界或 `reserved >= max` 时 fail fast；不得假报 compaction job 或静默返回完整超大输出 |

## 5. 工具与双向交互

**设计目标：** 以统一的工具契约执行文件、搜索、Shell、任务和交互能力，在产生副作用前完成
参数校验与审批。

**职责：** 定义工具 schema、权限描述、patch 原子应用、搜索路由、大输出持久化，以及
`request_user_input` 的请求/恢复。

**边界与依赖：** 工具依赖注入的环境与权限 port；Server 负责把 deferred interaction 映射为
Server Request；Client 只展示和回传决策。

| ID         | 具体功能                | 输入                                           | 处理流程                                                                                                    | 预期结果                                                                                  | 异常与边界行为                                                                             |
| ---------- | ----------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `F-TOL-01` | 文件、搜索与 Shell 工具 | 结构化路径/模式/命令、cwd、allowed roots       | schema 校验后解析规范路径，执行读写、正则搜索或命令，并生成结构化 metadata                                  | 搜索限制命中数；无匹配是成功空结果；Shell 返回 exit code/stdout/stderr；文件变更产生 diff | 路径越界、非法 regex、超时、缺失环境均形成工具失败；不能绕过审批写工作区外目录             |
| `F-TOL-02` | Apply Patch 原子协议    | `*** Begin Patch` 操作集合                     | 先完整解析和 preview 所有 add/delete/update/move，再一次性提交文件变更                                      | 成功时所有操作生效并返回逐文件 diff；支持 EOF marker 和尾换行                             | 传统 unified diff 返回可操作错误；任一 preview/写入失败时不得留下部分变更                  |
| `F-TOL-03` | 工具搜索与代理调用      | 搜索 query、mode、目标工具名与参数             | routing 开启时仅暴露 meta tools；索引按 exact/prefix/fuzzy 排序；代理调用复用目标 schema/审批               | 可发现当前 mode 可用工具；逻辑事件投影为真实目标工具；目标输出原样保留                    | 未知、递归 meta 调用、schema 非法和超大搜索结果直接拒绝；交互工具不进入代理目标集          |
| `F-TOL-04` | 用户输入请求            | 1–3 个问题、每题 2–4 个选项、Client resolution | 严格校验 id/label，持久化 pending request；Client 可提交选择、Other、chat 或 denied；恢复查找唯一未完成请求 | resolution 与原问题逐项匹配；断线恢复后仍可继续；处理完成发出 resolved                    | 重复 id/label、空 Other、缺题、重复响应或已取消 request 被拒绝；只有第一条有效响应产生效果 |

## 6. 配置与模型目录

**设计目标：** 保持一套严格、可组合、可精确写入的 Server 配置，并从中解析 provider、模型和
profile 的具体运行设置。

**职责：** 初始化模板，加载 global/project source，校验并合并 YAML，提供 dotted path 写入和
provider/model/profile catalog。

**边界与依赖：** 配置由 Server 独占；TUI 只能调用 `config/*`。TUI 的主题等显示偏好存于独立
`tui.json`，不得进入 Server 配置。

| ID         | 具体功能                        | 输入                                         | 处理流程                                                                      | 预期结果                                                                                                       | 异常与边界行为                                                                                                 |
| ---------- | ------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `F-CFG-01` | 初始化、加载与合并              | ELLO_HOME、cwd、global/project YAML          | 缺省时复制模板，分别校验 source，再按允许范围合并为 runtime config            | 路径规范化；默认 tools/provider/model/profile 完整；多次初始化幂等                                             | 项目级 profile、`active_profile`、`default_agent` 等 Server-global 字段直接拒绝；未知键和旧运行键不兼容        |
| `F-CFG-02` | 精确读取与写入                  | source、dotted path、JSON/YAML value         | 读取指定 source；候选合并结果先校验，再通过同目录临时文件原子替换目标叶节点   | 未触达配置与注释尽量保留；profile create/delete/role binding 不覆盖整个 map；RPC URL 去除 userinfo/token query | 非法 source/path/value、未知模型引用和 provider/model 路径不一致返回具体 issue；校验或写盘失败不破坏旧文件     |
| `F-CFG-03` | Provider、Model 与 Profile 解析 | provider credential、model ref、profile role | 合并内置与自定义目录，规范化 model ref，为每个 role 生成具体 adapter settings | catalog 可按 provider 展示；active profile 的每个 role 解析到确定模型；支持 OpenAI-compatible                  | 未知 provider/model/profile、缺 credential、能力不兼容或 role 绑定缺失 fail fast；不同 provider 不错误复用实例 |

## 7. 权限与会话模式

**设计目标：** 所有副作用由 Server 使用同一策略决定，且 Plan、Bypass 等会话模式具有明确的
安全边界。

**职责：** 匹配权限规则、生成审批请求、持久化项目批准规则、计算不同 session mode 的允许
动作。

**边界与依赖：** TUI 可分类展示风险但不得决定权限。工具提供 descriptor，permission engine
给出 `allow`、`ask` 或 `deny`。

| ID         | 具体功能         | 输入                                                              | 处理流程                                                                       | 预期结果                                                                         | 异常与边界行为                                                                              |
| ---------- | ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `F-PER-01` | 权限规则求值     | tool descriptor、路径/命令 metadata、规则序列                     | 按声明顺序匹配，最后命中规则生效，无命中采用安全默认                           | 相同输入得到稳定决策；默认是 `ask`；deny 不进入执行器                            | 无效规则或 metadata 直接拒绝；Client 伪造展示字段不能改变 Server 决策                       |
| `F-PER-02` | 审批与规则持久化 | accept once/session、project approval、decline/cancel             | 临时授权绑定 turn/session；同次审批的工具与外部目录规则成批校验并原子写入 YAML | 批准范围不外溢；重新加载后项目规则可用；session 外部路径可复用；拒绝产生可见终态 | 写盘或 metadata 失败不发布部分/幽灵授权；重复、过期、跨 thread 或扩大范围的 response 被拒绝 |
| `F-PER-03` | Session Mode     | `ask-before-changes`、`accept-edits`、`plan`、`bypass` 与安全开关 | Server 根据 mode 收窄工具集和审批；Client Shift+Tab 只发 mode 更新请求         | Plan 禁止未批准写操作；`accept-edits` 只放宽编辑；bypass 仅在显式启用后可选      | bypass 未启用时拒绝；mode 更新不能在 Client 本地假成功；未知 mode 由协议层拒绝              |

## 8. Skill 与 Subagent

**设计目标：** 从可信目录发现可预算展示的 Skill，并以隔离权限和独立生命周期执行子 Agent。

**职责：** 解析 `SKILL.md`、构建搜索索引、激活指令；合并 builtin/project/config Agent，派生
subagent 权限并管理后台任务。

**边界与依赖：** Skill/Agent 目录由 Server 读取；Client 只接收 catalog。Subagent 继承上下文
时不能自动继承父 Agent 的高权限。

| ID         | 具体功能                      | 输入                                                   | 处理流程                                                                                                                                 | 预期结果                                                                                                   | 异常与边界行为                                                                                           |
| ---------- | ----------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `F-SKL-01` | Skill 发现与索引              | global/project Skill roots、预算                       | 跟随有效目录链接，严格解析 frontmatter，按稳定顺序生成名称/说明摘要                                                                      | 全部有效 Skill 可搜索；索引在预算内；保留 link path 与 real path 便于诊断                                  | 缺 name/description、unknown frontmatter、broken symlink 或重复冲突使加载失败，不静默忽略                |
| `F-SKL-02` | Skill 激活                    | 显式 `$skill` 或模型 `activate_skill` 调用             | 在 run snapshot 中加载完整指令并记录来源；重复激活去重                                                                                   | 当前或规定的下一轮模型输入包含 Skill 指令；未激活 Skill 只出现在摘要                                       | 未知/禁用 Skill 返回工具失败；动态激活不得改变已缓存的稳定 system 前缀                                   |
| `F-SKL-03` | Agent registry 与后台任务边界 | builtin、Markdown、config definition、父权限、任务描述 | 按 project > config > builtin 合并，派生最小权限并提供 parent 隔离的后台 store；当前生产目录对未装配 runner 的 Subagent 标记 unavailable | hidden/mode 筛选和 override 可预测；领域任务完成/取消可查询；Client 不会把不可执行 Subagent 展示为 enabled | 未知 Agent/frontmatter fail fast；只继承父级 deny；没有 delegation runner 时不得注册假工具或假报后台完成 |

## 9. Memory、Goal 与 Plan

**设计目标：** 为长程知识、持续目标和计划审批提供可持久化但不污染普通消息历史的业务状态。

**职责：** 管理文件 Memory 索引与后台作业；管理 Goal 生命周期、预算和 blocker；保存 Plan
artifact 并驱动 mode 切换。

**边界与依赖：** Memory 和 Goal 通过 port 持久化；Thread projection 只保存其可恢复状态。
Client 通过 RPC 读取/修改，不直接访问文件或数据库。

| ID         | 具体功能                     | 输入                                                    | 处理流程                                                                                                                                               | 预期结果                                                                                            | 异常与边界行为                                                                                              |
| ---------- | ---------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `F-MEM-01` | Memory 文件与索引            | private/team scope、topic mutation、revision            | 严格解析 frontmatter，以 revision 做乐观并发写入，自动维护 `MEMORY.md`                                                                                 | create/update/delete 后索引一致；search 返回稳定匹配；disabled 时不创建目录                         | 非法 scope/type、超长索引、symlink、revision 冲突或损坏 frontmatter fail fast                               |
| `F-MEM-02` | Memory 注入与重载            | enabled/ignore 标志、两个 scope index                   | run 开始加载一次 index；reload 重新校验并刷新；ignore 完全跳过                                                                                         | enabled 时只注入预算内索引，不自动注入全部 topic；状态 RPC 始终可读                                 | disabled 时 reload/dream 明确失败；单次 run 中途变化不改变 snapshot                                         |
| `F-MEM-03` | Extraction 与 Dream 能力门禁 | 已提交用户 turn、dream 请求、Memory enabled 状态        | 重构版尚未装配 durable extraction/dream runner；RPC 在校验配置后明确拒绝，不创建 job、不发送 started/completed 通知                                    | 调用方得到稳定的 unavailable 错误；普通 Memory CRUD/索引不受影响；不存在虚假 pending/completed 状态 | disabled 与 runner 缺失分别诊断；未来恢复能力时必须同时增加 durable 去重、恢复、失败/取消和关闭等待测试     |
| `F-GOL-01` | Goal 生命周期                | objective、可选 token budget、pause/resume/clear/update | 校验并创建唯一 active goal，持久化 latest snapshot；clear 写独立审计记录                                                                               | pause/resume 保留目标；clear 后查询为空；fork 生成新 ID 且默认 paused                               | 空 objective、非法 budget、替换 active goal、错误状态转换直接拒绝                                           |
| `F-GOL-02` | Goal 延续与停止              | 每轮 usage、`update_goal`、host continuation limit      | 生产 Thread 累计不含 cache read 的 billable tokens并在预算耗尽时 pause；Goal 工具只允许显式 complete/blocked；领域控制器保留 continuation/blocker 规则 | 预算耗尽只暂停、不伪造成 complete；终态工具更新与本 Turn usage 归入同一 Goal；状态对 Client 可见    | 未装配自动 continuation runner 时不自行续跑；领域控制器要求同一 blocker 三次才 blocked，条件变化重置 streak |
| `F-GOL-03` | Plan artifact 与批准         | Plan mode 输入、计划内容、accept/reject                 | 保存结构化 Plan 与 artifact，发出审批；accept 后进入默认执行 mode 并保留计划历史                                                                       | 当前 Plan 可恢复、可展示；拒绝不执行写工具；接受一次只启动一个执行阶段                              | 非 Plan mode 不能伪造待批准 Plan；重复批准/过期 request 无副作用；artifact 损坏直接报告                     |

## 10. Workspace 与 Repository

**设计目标：** 用稳定身份管理本地/远程仓库、工作区、引用 checkout 和归档代次，同时保护用户
未提交工作。

**职责：** 导入 mirror、fetch、创建 selector workspace、detached reference、archive/reconcile/
repair/delete，以及 local-only bundle 导入导出。

**边界与依赖：** Git 和文件操作通过 workspace service 执行，元数据由 repository 持久化。
Client 只能调用独立 RPC；Server 不删除无法证明由 Ello 管理的用户目录。

| ID         | 具体功能                     | 输入                               | 处理流程                                                                                             | 预期结果                                                                    | 异常与边界行为                                                                                            |
| ---------- | ---------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `F-WSP-01` | Repository 导入与同步        | local path 或 remote URL、repo key | 规范 remote，生成稳定 ID 和独立 mirror；local-only 仅导入 branches/tags                              | 重复导入身份稳定；远程保留 origin；带斜杠 repo key 形成分层安全路径         | local-only fetch 明确失败；remote add 失败补偿清理；保留分支命名空间被拒绝                                |
| `F-WSP-02` | Workspace 创建与扩展         | selector、repo 集合、可选新 repo   | 在规范路径创建 checkout，共同分支按 selector 规则生成；可向现有 workspace 添加 repo                  | standard/refactor selector 语义稳定；新 repo 同时进入 registry 和 workspace | 同名活动 workspace、非法 selector/path 或缺失 repo fail fast；不写旧 marker/manifest 双源                 |
| `F-WSP-03` | Detached Reference           | repo、commit/ref、引用名称         | 创建与主开发 checkout 分离的只读语义 reference，并记录完整生命周期                                   | reference 位于 `references/`；不改变开发分支；可独立归档和删除              | 无效 ref、与开发路径冲突或被引用对象仍在使用时拒绝删除                                                    |
| `F-WSP-04` | Archive、Reconcile 与 Repair | workspace ID、当前磁盘与 DB 状态   | archive 保留完整 checkout并修复 worktree metadata；reconcile 只诊断；repair 只重建可证明安全的缺失项 | 支持同 selector 多代 archive；旧 missing/path 状态收敛到规范值              | dirty worktree fail fast；非 Git 占位目录报告 invalid 且不删除；多版本按 selector 删除被拒绝，必须使用 ID |
| `F-WSP-05` | 删除与导入导出               | workspace/repo ID、bundle          | 校验引用与 dirty 状态后删除元数据和受管路径；local-only 用 bundle 重建 registry；批量导入逆序补偿    | 删除后无悬挂引用；bundle 可在新 root 重建相同 repository 能力               | repo 仍被 workspace/reference 使用时拒绝；bundle 损坏或目标冲突会清理当前及已导入 mirror，不产生半状态    |

## 11. 持久化、Artifact 与 Task

**设计目标：** 提供单一全局数据库、事务化业务 repository 和内容寻址 Artifact，避免旧版多套
session/storage 路径并存。

**职责：** 初始化 Drizzle baseline、执行 repository 事务、管理 artifact/checkpoint/usage/task
board，并提供 Thread Catalog 投影存储。

**边界与依赖：** 数据库实现不拥有 Thread 状态机；JSONL 先提交，再投影 SQLite。所有数据库
路径从 Server root 解析。

| ID         | 具体功能               | 输入                                                    | 处理流程                                                                                        | 预期结果                                                                            | 异常与边界行为                                                                                                     |
| ---------- | ---------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `F-STO-01` | 全局数据库与迁移       | Server root、Drizzle migration、旧 `state.sqlite`       | 创建 `state/ello.sqlite`，启用规定 PRAGMA，事务化应用 baseline；首次启动只读幂等导入旧 registry | table/index/FK/trigger 完整；旧 repo/workspace 保留；重复启动不重复迁移；close 幂等 | schema/journal 漂移、数据库版本过高或 migration 失败整体回滚；旧库损坏或字段不兼容时 fail fast；关闭后查询直接失败 |
| `F-STO-02` | Artifact 与 Checkpoint | bytes、media type、owner ref、checkpoint changes        | 以 sha256 内容寻址去重，记录引用；checkpoint seal 保存快照；回滚前模拟完整逆序状态链            | 同内容只存一份；最后引用释放后删除；未漂移时按 before 逆序恢复文件                  | 读取时 size/hash 不符 fail fast；文件漂移、symlink/目录或任一 preflight 失败时工作区零修改                         |
| `F-STO-03` | Task Board             | thread/board ID、task mutation、dependency、claim owner | board 内独立 sequence；事务化更新 task 与单向 dependency；claim 使用竞争保护                    | blocks/blockedBy 投影一致；blocker 完成后可 claim；事件绑定正确 board               | self/cross-board dependency 拒绝；并发 claim 仅一个成功；失败不留下 task/dependency/sequence 半状态                |
| `F-STO-04` | Usage 与 Model Call    | 安全 usage、model、status、fingerprint、日期            | 保存非敏感字段，按模型/日期/status 聚合，保留 cache miss 诊断                                   | run/model-call 汇总可查询；cache read/write 分开；工具 schema 变化可追踪            | 缺必需 token detail 或负数 usage 拒绝；不得保存 prompt、credential 等敏感正文                                      |
| `F-STO-05` | Thread 查询投影        | 已提交 ThreadRecord、期望 seq                           | 在单事务中推进 catalog、item、pending request、goal/plan/usage/compaction                       | list/filter/sort/page 只查 SQLite 且稳定；settings-only 记录也推进 catalog seq      | seq gap、错误 thread ID 或 rebuild 失败保留旧投影；不能通过读损坏 transcript 完成 list                             |

## 12. Thread、Turn 与恢复

**设计目标：** 以 Thread/Turn/Item 和单调 sequence 作为所有连接共享的权威状态，支持并行
Thread、单 Thread 串行 mutation、fork、断线与进程重启恢复。

**职责：** 写 Thread Log、投影 snapshot、管理 runtime/lease、发布 notification、保存 transcript
并协调 Server Request。

**边界与依赖：** Domain projection 是纯函数；runtime 通过 TurnExecutor port 调用 Agent；storage
只保存 record。Connection 不拥有业务状态。

| ID         | 具体功能                | 输入                                                | 处理流程                                                                                                                 | 预期结果                                                                                            | 异常与边界行为                                                                               |
| ---------- | ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `F-THR-01` | Thread Log 与 Snapshot  | typed record、thread ID、前序 seq                   | 单 writer 串行 append JSONL，提交后用纯 projection 重建 Thread/Turn/Item snapshot                                        | 并发 append 仍连续；每条 notification 对应 record 已先落盘；archive 不创建第二事实源                | 断行、seq gap、跨 thread record 和第二个 active lease fail fast；不可序列化值不写入          |
| `F-THR-02` | Thread 创建、读取与列表 | cwd、concrete settings、include flags、filter/page  | 创建时固化具体 settings；首条输入写 preview；首个成功 Turn 用 title role 生成名称；read 读取 snapshot；list 只查 Catalog | 标题与 preview 持久化并进入列表；read 不加载 executor；分页排序稳定；不同 Thread 状态隔离           | 标题模型失败不改变 Turn 终态；配置解析失败不创建 Thread；缺失 Thread 返回 typed notFound     |
| `F-THR-03` | Turn 生命周期           | Thread ID、UserInput[]、可选 metadata               | 先持久化 turn/item，再异步执行；delta 更新 item；完成时写终态与 usage                                                    | start 快速返回 inProgress；每个 turn/item ID 全局稳定；终态只出现一次                               | 同 Thread 同时仅一个 active turn；空 input、stale turn 或终态后 mutation 拒绝                |
| `F-THR-04` | Steer 与 Interrupt      | expected/actual turn ID、结构化输入、reason         | steer 排入当前 runtime 下一轮；interrupt 幂等触发 abort 并提交终态                                                       | 正确 turn 收到 steer；重复 interrupt 返回同一终态，不新增虚假记录                                   | expected ID 不匹配、无 active turn 或已关闭 Thread fail fast；跨 Thread 不可操作             |
| `F-THR-05` | Fork、Archive 与 Delete | source Thread、目标 turn、管理动作                  | fork 复制目标前缀并生成全新 Thread/Turn/Item ID；archive/unarchive/delete 同步 log 与 catalog                            | 原 Thread 不变；fork snapshot 一致；管理动作对列表立即可见                                          | 活跃 mutation、非法 turn、引用冲突或非可删除 root 拒绝；重复 archive/unarchive 语义明确      |
| `F-THR-06` | 启动与断线恢复          | Server root、偏离 catalog、未完成 turn/item/request | 获取 lease，扫描未被活跃进程持有的 log，回填旧 Thread preview 并重建 catalog；将丢失的 active 状态提交为 `interrupted`   | restart 后无幽灵 active turn；旧会话可用首条输入展示；其他 Server 可继续管理 RPC；resume 可重放请求 | 活跃 lease 在启动恢复中跳过，实际 resume 仍返回 threadBusy；catalog rebuild 失败不覆盖旧投影 |

## 13. JSON-RPC 协议与 Server

**设计目标：** 用版本化、严格、可生成 fixture 的 JSON-RPC 契约隔离 Client 与 Server 实现。

**职责：** 定义 envelope、Client Request、Notification、Server Request 与错误；执行 handshake、
路由、response barrier 和 subscription。

**边界与依赖：** `protocol/` 不依赖 Server/Storage/Agent；router 只做 schema 与 dispatch；业务
handler 在 `server/methods`。

| ID         | 具体功能                     | 输入                                                           | 处理流程                                                                                      | 预期结果                                                                        | 异常与边界行为                                                                                    |
| ---------- | ---------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `F-RPC-01` | Protocol v1 schema           | JSON-RPC id/method/params/result、fixture catalog              | 对所有稳定 method 使用 strict Zod schema，catalog 固定完整 wire sample                        | string/number/null id、notification、双向 Server Request 可互操作；未知字段拒绝 | method/schema 增删引起 fixture drift；parse error 使用 null id；响应 schema 错误与业务错误可区分  |
| `F-RPC-02` | Initialize gate              | protocolVersion、capabilities、client info、`initialized` 通知 | 第一条合法请求必须 initialize；协商 capability 后等待 initialized 再开放业务路由              | 握手成功后业务请求可用；server info/capabilities 明确                           | 握手前业务请求、重复 initialize、版本不匹配和错误通知顺序返回稳定 typed error；版本不匹配关闭连接 |
| `F-RPC-03` | 业务路由与错误模型           | 已注册 method、strict params、handler result                   | 校验 params，调用一次 handler，再校验 result 并映射领域错误                                   | 未知 method、配置无效、notFound、busy、mismatch 等有稳定 code/data              | handler 内部错误不泄露 secret/stack；响应违反 schema 使用独立 internal contract error             |
| `F-RPC-04` | Subscription、序号与响应屏障 | thread subscription、resume seq、notification/server request   | 先完成 resume/read response，再释放 snapshot 后 live event 和 pending request；按 thread 过滤 | Client 不会在 response 前收到竞态事件；公开 seq 连续；未订阅连接不串线          | gap 不静默跳过；连接慢时按背压策略关闭；pending request 只接受第一条 response                     |
| `F-RPC-05` | Server 文件与 Watch 服务     | cwd、路径/query/kind/limit、maxBytes、watch ID、连接 ID        | realpath 与词法路径双重限制在 cwd；严格 UTF-8 并按字符边界预览；目录/搜索排序；watch 绑定连接 | 文件正文/metadata/search 结果稳定；超预览内容进入 Artifact；watch 产生变更通知  | 穿越、外链、二进制、超过 8MB 文件或 1MB preview 拒绝；其他连接不能 unwatch；断线自动清理 watcher  |

## 14. Transport 与 Server 进程

**设计目标：** 同一 RPC processor 支持本地 stdio、远程 WebSocket 和 Unix socket，并提供安全
鉴权、背压和优雅关停。

**职责：** framing、连接生命周期、health/auth/origin、outbound queue、信号与 EOF 处理。

**边界与依赖：** transport 不理解业务 method；stdout 在 stdio 模式专用于 JSONL，日志只写
stderr。

| ID         | 具体功能      | 输入                                                    | 处理流程                                                                                      | 预期结果                                                                        | 异常与边界行为                                                                    |
| ---------- | ------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `F-TRN-01` | Stdio 子进程  | stdin JSONL、stdout/stderr、EOF                         | 按行 framing 进入统一 processor；构建产物 `server/entry` 启动 Server                          | stdout 每行都是 JSON-RPC；EOF 优雅停止并 code 0 退出                            | 半行/坏 JSON 返回 parse error 且可继续；日志不得污染 stdout；启动配置非法非零退出 |
| `F-TRN-02` | TCP/WebSocket | listen address、Bearer token、Origin allowlist、HTTP/WS | health 走 HTTP；upgrade 前完成 auth/origin；message 进入 RPC framing                          | 合法连接与 stdio 语义一致；health 可探测；第二连接独立                          | 缺失/错误 token 为 401；非法 Origin 拒绝；畸形 frame 不影响其他连接               |
| `F-TRN-03` | Unix Socket   | socket path、Bearer token                               | 创建/替换受管 socket，设置 `0600`，通过 HTTP Upgrade 承载 WebSocket                           | 本机远程式连接可用，framing 与 TCP 一致                                         | 非受管现有路径不覆盖；权限设置失败立即停止；关闭后清理 socket                     |
| `F-TRN-04` | 背压与关停    | outbound queue limit、SIGTERM/SIGINT、shutdown RPC      | 每连接有界排队；过载只关闭慢连接；停止时先中断活跃 run、flush record/recorder 再关闭 listener | 慢连接不阻塞其他 Client；active turn 重启后为 interrupted；正常 shutdown code 0 | 不静默丢终态消息；超出 graceful deadline 仍要保留可恢复记录；重复 stop 幂等       |

## 15. Client 与连接恢复

**设计目标：** 为 CLI/TUI 提供唯一 typed Client，隐藏 transport、请求关联、Server Request 和
Thread sequence 恢复细节。

**职责：** 连接/初始化、pending request map、错误分类、ThreadClient projection、gap recovery、
审批与用户输入 response。

**边界与依赖：** 仅依赖 `@ello/agent/protocol` 类型；不得 import Server implementation、AI SDK、
SQLite 或 provider credential。

| ID         | 具体功能                     | 输入                                       | 处理流程                                                                          | 预期结果                                                                               | 异常与边界行为                                                                               |
| ---------- | ---------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `F-CLT-01` | Typed AppServerClient        | transport、initialize params、typed method | 完成握手后分配 request ID，按 ID 关联乱序 response，校验 result                   | 并发 request 各自得到正确结果；notification 和 response 分流                           | 握手前请求拒绝；timeout 清理 pending；Server error、transport error、schema error 类型可区分 |
| `F-CLT-02` | Server Request 响应          | approval/user-input request、显式 handler  | handler 显式声明接管；允许 UI 延迟响应；发送 response 前先从本地 pending 移除     | 弹窗显示后请求保持 pending；UI 重渲染或双击不会重复提交；response 与原 request ID 匹配 | 仅无人接管时自动拒绝；未知类型不自动批准；handler 抛错不吞掉 pending 状态                    |
| `F-CLT-03` | ThreadClient 与 gap recovery | Thread ID、snapshot、带 seq notification   | reducer 严格比较 seq；真实 gap 标记 stale 并只触发一次 resume；用新 snapshot 替换 | 正常 sequence notification 推进；恢复后可继续 submit；切 Thread 关闭旧订阅             | stale 期间 submit 拒绝；重复/旧 seq 不重复投影；恢复失败保持 stale 并向 UI 报错              |
| `F-CLT-04` | 本地与远程连接               | 默认 local、`ws://`、`unix://`、token      | local 解析 `server-entry` 并启动隔离子进程；remote 选择对应 transport并初始化     | 三种连接向上提供相同 ClientConnection；close 清理资源                                  | 不 import `server-entry` 执行代码；子进程提前退出、socket 断开或 endpoint 非法返回可诊断错误 |

## 16. CLI

**设计目标：** 提供统一 `ello` 入口，让交互 TUI、一次性 run 和管理命令都只使用 Client RPC。

**职责：** 参数解析、本地/远程连接、non-interactive render、Server launcher 和退出码。

**边界与依赖：** CLI 不读取 Server YAML/SQLite/Git，不创建模型或执行工具；所有业务命令映射到
独立 RPC。

| ID         | 具体功能          | 输入                                                    | 处理流程                                                                   | 预期结果                                                          | 异常与边界行为                                                                           |
| ---------- | ----------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `F-CLI-01` | 启动与连接选择    | global options、remote endpoint、auth token、cwd        | 解析一次选项，创建 local/remote Client，完成 handshake，再进入子命令或 TUI | 默认本地进程隔离；remote 不启动本地 Server；help 不产生业务副作用 | 冲突参数、非法 endpoint、缺 token 或初始化失败返回非零退出并给出可操作错误               |
| `F-CLI-02` | 一次性 Run 与渲染 | prompt、thread/profile/mode options、`--json`           | start/resume Thread，发起 turn，消费通知直到终态，按 text/JSON 输出        | 成功输出最终内容和稳定退出码；JSON 可机器读取                     | failed/interrupted/timeout 使用非成功语义；stderr 与 stdout 数据边界明确；不得绕过审批   |
| `F-CLI-03` | 管理命令          | config/model/skill/memory/goal/task/repo/workspace 操作 | 将每个命令转换为 typed RPC，渲染 Server result                             | 命令行为与 TUI 使用同一 Server 事实源                             | 未实现旧命令明确报告 unknown/removed，不回退读取本地旧存储；错误保留 Server code/message |

## 17. TUI 交互与展示

**设计目标：** 在终端中稳定展示 committed history、live state 和交互浮层，同时保持输入编辑、
补全与恢复行为可预测。

**职责：** Composer、slash command、file/Skill 补全、timeline projection、工具卡片、diff、
permission/user-input/profile/workspace/theme overlay。

**边界与依赖：** TUI 只处理显示模型和用户意图；文件搜索、profile 写入、workspace 和权限决策
全部委托 Server。唯一 Client 本地写入是 `tui.json` 显示偏好。

| ID         | 具体功能                          | 输入                                                      | 处理流程                                                                                                              | 预期结果                                                                                              | 异常与边界行为                                                                                                                |
| ---------- | --------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `F-TUI-01` | 多行 Composer                     | terminal key/input、buffer、cursor、history、suggestion   | 使用纯 buffer 操作插入/删除/跨行移动；过滤 mouse/control sequence；submit 保留完整文本                                | DEL/BS、word delete、line kill、上下左右和多行提交稳定；overlay 打开时停用                            | 文首/文尾操作幂等；不插入终端鼠标序列；空白提交无副作用；运行中提交变成 steer                                                 |
| `F-TUI-02` | 命令、文件与 Skill 补全           | 光标前 token、slash/profile/file/Skill 候选、frecency     | 识别 `/ @ # $` 词元边界，按 exact/prefix/basename/fuzzy/depth/frecency 排序，只替换活动 token                         | `/profiles` 使用 profile 名而非 model ID；文件候选来自 `fs/search`；Skill 显示来源和单行摘要          | 邮箱/词中符号不触发；无匹配不弹层；光标中间接受建议不删除后续文本；候选上限稳定                                               |
| `F-TUI-03` | 结构化用户输入                    | Composer 文本中的 `@file`、普通文本                       | 调用 Server `fs/search` 解析明确文件引用，按规范路径去重并生成 text/file `UserInput[]`，保留 display name             | Server 收到结构化文件路径而不是 Client 读取并内联文件；普通文本保持原意                               | 未匹配 mention 保留为文本；邮箱不识别；重复文件只提交一次；搜索错误向用户显示且不提交半输入                                   |
| `F-TUI-04` | Timeline 与历史投影               | ThreadSnapshot、typed notification、UI message            | committed history、live item、usage、goal、plan、pending interaction 分层投影；snapshot replacement 清空旧 live state | item 不重复；assistant/tool delta 进入对应 item；历史不混入 live viewport                             | 缺配对 tool result、非法状态转换或未知 payload 明确失败/诊断；duplicate notification 不重复显示                               |
| `F-TUI-05` | 工具、Diff 与路径展示             | command/file change/subagent item、cwd/home/artifact path | 构建 tool card，解析 unified diff 双行号，按 cwd/home 缩短路径，限制 nested activity                                  | 成功默认折叠；diff/失败展开；重命名与增删统计正确；artifact 显示紧凑 ID                               | 空 diff 为空；损坏 fileChanges metadata 拒绝；外部绝对路径不伪装成 workspace 内路径                                           |
| `F-TUI-06` | 审批与用户输入 UI                 | pending Server Request、resolution callbacks              | 按 edit/shell/read/search/network/task 分类；危险命令提示；问题支持单选/多选/Other/review/chat/deny                   | 审批只显示 diff 摘要；提交期间禁用重复 response；resolution 完整匹配协议                              | Other/Chat 空文本不提交；无选择时提示；回调失败恢复可重试状态；UI 不自行决定 allow                                            |
| `F-TUI-07` | Overlay、Rewind、Profile 与 Theme | Server catalogs/snapshot、overlay action、本地主题        | 显示有界 picker；rewind 映射 entry→turn 后 fork 并回填 prompt；profile 精确写 path；主题原子写 `tui.json`             | workspace 只展示 Server summary；profile create/delete/activate/role 不覆盖无关配置；theme 跨进程保留 | 无效 profile 数据 fail fast；不存在 rewind target 不 fork；本地 UI schema 拒绝 provider 等 Server 字段；配置文件权限为 `0600` |

## 18. 可观测性与发布边界

**设计目标：** 在不泄露用户内容和凭据的前提下提供可诊断 telemetry，并保证发布产物严格遵守
Server/Client 依赖边界。

**职责：** model-call lifecycle、usage/fingerprint、Langfuse/OpenTelemetry 配置、build 与 dist
边界校验。

**边界与依赖：** tracing disabled 时不得要求外部连接；TUI bundle 不得包含 Server runtime 或
provider 依赖。

| ID         | 具体功能        | 输入                                                      | 处理流程                                                             | 预期结果                                                                                   | 异常与边界行为                                                                                      |
| ---------- | --------------- | --------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `F-OBS-01` | Model Call 观测 | model、usage、finish status、fingerprints、content policy | 调用前后记录安全 attribute，flush recorder 后才完成 run              | usage、cache、toolset/instruction fingerprint 可关联；默认不记录正文                       | recorder 失败使 run 明确失败；无效 usage 拒绝；credential、完整 prompt/tool output 永不写 telemetry |
| `F-OBS-02` | Tracing 配置    | enabled、endpoint/public/secret key、routing switch       | disabled 只校验基础类型；enabled 时要求完整连接字段并初始化 exporter | 关闭 tracing 可离线运行；合法配置产生 recorder                                             | enabled 缺字段、非法 URL/开关直接报 config issue；初始化失败不悄悄降级                              |
| `F-REL-01` | Agent 发布边界  | package exports、build input、dist verifier               | 构建 Server、protocol fixture 和声明文件，扫描批准出口               | 根出口只含 Server 生命周期；`./protocol` 稳定；`server-entry` 可独立启动                   | 不暴露旧 SDK/internal 子路径；缺 fixture、入口或 sourcemap 时 verify-dist 失败                      |
| `F-REL-02` | TUI 发布边界    | package exports、bundle、lint zones                       | 构建 Client CLI/TUI 并扫描依赖和敏感符号                             | bundle 不含 AI SDK、SQLite、Server runtime/provider credential；只通过 protocol 依赖 Agent | 发现旧 `@ello/coding-agent`、private Server import 或敏感依赖时构建/检查失败                        |

## 19. 有意的破坏性变更

以下变化是新架构契约，不应通过兼容分支恢复旧实现：

1. 旧 `@ello/agent` SDK 公共运行入口已删除，根出口只提供 App Server 生命周期。
2. 旧 `@ello/coding-agent` 包、进程内 `CodingSession`、多套 session JSONL/SQLite 路径已删除。
3. TUI 不再读取配置、Git、数据库或文件正文；`@file` 作为结构化路径交给 Server/Agent。
4. 旧 Commander 业务命令不在 Client 复制实现，统一映射到 Server RPC。
5. Thread Log/Catalog 不兼容读取旧 session 数据；版本不匹配应 fail fast，而不是猜测迁移。
6. 协议使用 strict schema；旧字段、unknown field 和错误顺序不再宽松接受。

## 20. 完成定义

一个功能只有同时满足以下条件才视为完成：

1. 在本文件拥有唯一且稳定的功能 ID，并明确输入、流程、结果和异常边界。
2. 在 `test-design.md` 中拥有正常、异常和边界场景，以及可执行的测试文件映射。
3. 测试断言可观察契约，不依赖私有方法调用次数、内部目录层级或无意义快照。
4. Server/Client 所有权、Thread 单一事实源和 strict protocol 三项架构边界未被破坏。
5. `pnpm contract:check`、类型检查、lint、全部测试、构建和 dist 检查通过。
