# Ello 测试设计与契约矩阵

本文档把 [`functional-design.md`](functional-design.md) 中的每个功能映射到可执行测试。
测试优先验证公开协议、持久化结果和用户可观察行为；目录结构、私有函数调用次数和组件拆分
不属于稳定契约。

## 1. 测试分层

| 类型           | 标记 | 验证内容                                             | 使用原则                                        |
| -------------- | ---- | ---------------------------------------------------- | ----------------------------------------------- |
| 纯契约单元测试 | U    | schema、纯状态机、解析、排序、权限矩阵               | 不 mock 被测规则本身；覆盖正常、异常和边界      |
| 领域集成测试   | I    | SQLite、JSONL、Artifact、真实 Git、文件系统          | 使用临时 root；断言提交后的外部状态和故障原子性 |
| 协议/组件测试  | C    | JSON-RPC wire、Client reducer、Ink 用户操作          | 从公开输入驱动，避免断言私有组件层级            |
| 真实进程端到端 | E    | build 产物、stdio/WebSocket/Unix、mock HTTP provider | 不以内存 adapter 绕过进程、framing、恢复和鉴权  |
| 静态/发布检查  | S    | package exports、依赖方向、dist 内容、文档映射       | 作为 CI 门禁，不代替业务运行测试                |

每项功能至少要求一个正常场景和一个关键失败场景；涉及数值、路径、状态机、恢复或并发的
功能还必须有边界场景。跨模块能力必须至少包含一个 I/C/E 测试。

## 2. 旧测试审查结论

### 2.1 原样保留或仅调整路径

这些测试直接断言业务结果，重构后继续作为有效契约：

| 旧测试                                                                   | 结论                                                    | 当前去向                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ello-agent/agent.test.ts`                                               | 保留；覆盖 run/stream、审批恢复、背压和停止条件         | `packages/ello-agent/tests/engine/agent.test.ts`                           |
| `ai-sdk-adapter.test.ts`、`usage.test.ts`、`model-call-observer.test.ts` | 保留；验证 provider 事件、严格 usage 与安全 fingerprint | `packages/ello-agent/tests/engine/`、`storage/`、`observability/` 对应文件 |
| `tool-scheduler.test.ts`                                                 | 保留并补充 schema/异常批处理；验证副作用前置条件        | `packages/ello-agent/tests/engine/tool-scheduler.test.ts`                  |
| `config.test.ts`、`provider-cache.test.ts`                               | 保留；验证配置语义、精确写入和 cache 契约               | `packages/ello-agent/tests/config/`、`context/` 对应文件                   |
| `permissions.test.ts`                                                    | 保留并补 capability/外部路径；旧三项不足以覆盖安全矩阵  | `packages/ello-agent/tests/permissions/permissions.test.ts`                |
| `skill-loader.test.ts`、`skills.test.ts`                                 | 保留；验证严格 frontmatter、symlink 和预算索引          | `packages/ello-agent/tests/skills/` 对应文件                               |
| `artifact-store.test.ts`、`tasks.test.ts`、`workspace.test.ts`           | 保留；均验证真实持久化/Git/事务结果                     | `packages/ello-agent/tests/storage/`、`workspace/` 对应文件                |
| `AppShell.test.tsx`、`PickerList.test.tsx`、`composer.test.ts`           | 仅保留用户可见内容和按键行为，删除组件树形状断言        | `packages/ello-tui/tests/presentation/`、`tui/`、`input/` 对应文件         |
| `theme.test.ts`、`tool-card.test.ts`                                     | 作为 UI 契约保留，不计作 Server 业务覆盖                | `packages/ello-tui/tests/settings/`、`presentation/` 对应文件              |

### 2.2 迁移为新的公开边界测试

| 旧测试                                           | 旧问题                                   | 当前替代                                                                                 |
| ------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `coding-session.test.ts`                         | 绑定 2800 行进程内 facade 和私有依赖注入 | `process-e2e.test.ts`、`app-server.test.ts`、`thread-manager.test.ts` 和领域测试组合覆盖 |
| `session-storage.test.ts`                        | 绑定旧 session-v3 文件布局               | `thread-log.test.ts`、`thread-catalog.test.ts`、`transcript-store.test.ts`               |
| `migration-runner.test.ts`、旧 `storage.test.ts` | 绑定手写 migration runner                | 新 `storage.test.ts` 验证 Drizzle baseline 和运行时约束；升级漂移需独立 fixture          |
| `plan-mode.test.ts`、`goal-runtime.test.ts`      | 绑定 CodingSession 方法                  | Thread Goal/Plan RPC、Agent executor 和真实进程场景                                      |
| `cli.test.ts`、`memory-cli.test.ts`              | 大量 mock Commander wiring，未证明业务   | CLI 进程/typed RPC 测试；Memory 行为在 Server/Repository 测试                            |
| 旧 `tui-event-store.test.ts`                     | 绑定旧产品事件 union                     | 新 snapshot + protocol notification reducer 测试                                         |
| `user-input.test.ts`                             | 旧 tool-call transcript 恢复形态         | protocol strict schema、Thread pending request 恢复和 `UserInputPanel` 测试              |

### 2.3 恢复的高价值细粒度契约

重构时以下纯行为测试曾被整批删除，但实现仍存在且不能只靠大 E2E 间接覆盖，因此已恢复：

- `autocomplete.test.ts`：词元边界、排序、frecency、不匹配。
- `composer-buffer.test.ts`：多行编辑、删除与光标边界。
- `completion.test.ts`：slash/profile/file/Skill 补全与中间词元替换。
- `diff.test.ts`：unified diff 分类、双行号、重命名和损坏 metadata。
- `permission-view.test.ts`：风险分类和“只展示摘要、不泄露完整 diff”。
- `model-selectors.test.ts`、`slash-commands.test.ts`：Server catalog 到用户动作的映射。
- `committed-history-store.test.ts`：不可变追加、乐观输入去重、snapshot 替换。
- `UserInputPanel.test.tsx`：single/multiple/Other/chat/deny、空输入和重复提交。

### 2.4 删除或不再恢复

- `public-api.test.ts` 的精确出口集合继续保留：该包明确承诺极小公开面，新增出口属于需要评审的发布契约变更；同时检查不得导出 internal 子路径。
- `AppShell` 的“只能包含某两个子组件”、`command-registry` 的“必须由某个数组作为唯一源”等组织方式断言删除。
- 旧 package 路径、旧 session header、旧 migration 文件名、旧 Commander handler 调用次数等实现细节不迁移。
- `tui/store/prompt-parts.ts` 已无生产调用，且让 Client 承担文件正文读取/模型序列化，违反新所有权边界；代码与对应旧测试一并删除，改测结构化 `UserInput.file`。
- 固定 sleep 的异步 UI 断言改用 `vi.waitFor` 或明确事件完成条件。

## 3. 功能测试矩阵

表中“核心场景”按“正常；异常；边界”排列。“测试文件”均相对于仓库根目录。

### 3.1 Agent、上下文与工具

| 功能 ID    | 核心场景                                                                  | 预期结果                                                      | 类型  | 测试文件                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `F-ENG-01` | run/stream 同形；adapter 无/多 final；abort                               | 正常结果一致；协议违规失败；abort 为 interrupted              | U/I   | `packages/ello-agent/tests/engine/agent.test.ts`                                                                                                                                             |
| `F-ENG-02` | 多轮 tool-call；重名/未知工具；maxTurns/no-progress                       | 工具结果进入下一轮；非法工具 fail fast；循环有界停止          | U     | `packages/ello-agent/tests/engine/agent.test.ts`、`packages/ello-agent/tests/engine/tool-scheduler.test.ts`                                                                                  |
| `F-ENG-03` | required/deferred/resume；拒绝；混合 batch                                | 未批准零副作用；恢复一次；混合批在执行前拒绝                  | U/E   | `packages/ello-agent/tests/engine/agent.test.ts`、`packages/ello-agent/tests/e2e/process-e2e.test.ts`                                                                                        |
| `F-ENG-04` | steer 顺序；慢消费者；缓冲溢出                                            | steer 进入下一轮；阈值内不丢；溢出明确失败                    | U     | `packages/ello-agent/tests/engine/agent.test.ts`                                                                                                                                             |
| `F-CTX-01` | 本地/URL/Skill source；同 run 文件变化；stale cache                       | 来源稳定排序；run snapshot 不漂移；刷新失败有诊断             | U/I   | `packages/ello-agent/tests/context/context-contract.test.ts`、`packages/ello-agent/tests/skills/skill-loader.test.ts`                                                                        |
| `F-CTX-02` | OpenAI/Anthropic stable/dynamic；工具 schema 变化；非法布局               | 稳定 key 可复用；toolset 变化；非法动态顺序失败               | U     | `packages/ello-agent/tests/context/provider-cache.test.ts`                                                                                                                                   |
| `F-CTX-03` | token 裁剪/非法预算；超大 Shell 输出；artifact 分块/缺失；手动 compaction | 模型输入受限；完整输出可取；非法预算和未装配 runner 明确失败  | U/I   | `packages/ello-agent/tests/context/context-contract.test.ts`、`packages/ello-agent/tests/storage/artifact-store.test.ts`、`packages/ello-agent/tests/server/server-services-runtime.test.ts` |
| `F-TOL-01` | read/write/edit/grep/glob/bash；路径越界/regex/timeout；空结果            | 结构化结果与 diff 正确；越界和非法输入失败；空搜索成功        | U/I/E | `packages/ello-agent/tests/tools/coding-tools-contract.test.ts`、`packages/ello-agent/tests/e2e/process-e2e.test.ts`                                                                         |
| `F-TOL-02` | add/delete/update/move；传统 diff；多文件 preview 失败                    | 原子应用全部操作；错误可操作；失败零写入                      | I     | `packages/ello-agent/tests/tools/coding-tools-contract.test.ts`                                                                                                                              |
| `F-TOL-03` | routing on/off；exact/fuzzy；未知/递归/schema invalid                     | 暴露面符合 mode；结果稳定；非法代理调用无副作用               | U/I   | `packages/ello-agent/tests/tools/coding-tools-contract.test.ts`                                                                                                                              |
| `F-TOL-04` | single/multi/Other/chat/deny；重复 id/缺题；重连恢复                      | resolution 完整；strict 错误；唯一 pending 可恢复且只响应一次 | U/C/E | `packages/ello-agent/tests/protocol/app-server.test.ts`、`packages/ello-agent/tests/thread/thread-manager.test.ts`、`packages/ello-tui/tests/tui/UserInputPanel.test.tsx`                    |

### 3.2 配置、权限、Skill 与长程能力

| 功能 ID    | 核心场景                                                                 | 预期结果                                                                           | 类型 | 测试文件                                                                                                                         |
| ---------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| `F-CFG-01` | 初始化/合并；项目 global 字段；损坏 YAML                                 | 默认完整且幂等；越权字段拒绝；损坏不回退                                           | I    | `packages/ello-agent/tests/config/config.test.ts`                                                                                |
| `F-CFG-02` | dotted set/delete；注释；schema/catalog/写盘失败；key/header/URL 脱敏    | 只改叶节点；失败保留旧文件；credential 不上 wire                                   | I/E  | `packages/ello-agent/tests/config/config.test.ts`、`packages/ello-agent/tests/config/config-response-security.test.ts`           |
| `F-CFG-03` | builtin/custom provider；profile roles；未知模型/credential              | catalog 和 role 解析正确；缺失/不兼容 fail fast                                    | U/I  | `packages/ello-agent/tests/config/config.test.ts`、`packages/ello-agent/tests/context/provider-cache.test.ts`                    |
| `F-PER-01` | 最后匹配；默认 ask；mode×permission；Client read capability              | Server 决策稳定；read 不能 shell/改状态；deny 优先                                 | U/C  | `packages/ello-agent/tests/permissions/permissions.test.ts`、`packages/ello-agent/tests/protocol/rpc-capabilities.test.ts`       |
| `F-PER-02` | accept/acceptForSession/decline；外部路径；批量规则/写盘失败             | scope 不外溢；session 可复用；失败无部分或幽灵规则                                 | I/E  | `packages/ello-agent/tests/permissions/permissions.test.ts`、`packages/ello-agent/tests/e2e/process-e2e.test.ts`                 |
| `F-PER-03` | 四种 mode；bypass 开关；运行中更新                                       | 工具/审批收窄正确；未启用 bypass 拒绝；配置持久                                    | U/C  | `packages/ello-agent/tests/protocol/app-server.test.ts`、`packages/ello-tui/tests/tui/App.test.tsx`                              |
| `F-SKL-01` | frontmatter、预算、project override；断链/重复 realpath                  | catalog 稳定且预算内；损坏导致 reload 失败并保留旧快照                             | U/I  | `packages/ello-agent/tests/skills/skill-loader.test.ts`、`packages/ello-agent/tests/skills/skills.test.ts`                       |
| `F-SKL-02` | 模型/显式激活；重复激活；未知 Skill                                      | 指令按 run 激活一次；未知给明确失败；cache 前缀稳定                                | U/E  | `packages/ello-agent/tests/engine/agent.test.ts`、`packages/ello-agent/tests/e2e/process-e2e.test.ts`                            |
| `F-SKL-03` | registry override/filter；权限派生；后台完成/取消/隔离；生产 runner 缺失 | 可选 Agent 和最小权限正确；后台状态按 parent 隔离；不可执行 Subagent 明确 disabled | U/I  | `packages/ello-agent/tests/skills/subagent-contract.test.ts`、`packages/ello-agent/tests/server/server-services-runtime.test.ts` |
| `F-MEM-01` | CRUD/revision/index/search；scope/frontmatter/symlink 冲突               | topic 与索引原子一致；非法与 revision conflict 零写入                              | I    | `packages/ello-agent/tests/memory/memory-contract.test.ts`                                                                       |
| `F-MEM-02` | enabled/disabled/ignore/reload；同 run snapshot                          | 只注入 index；disabled 无目录；reload 严格校验                                     | U/I  | `packages/ello-agent/tests/memory/memory-contract.test.ts`、`packages/ello-agent/tests/config/config.test.ts`                    |
| `F-MEM-03` | disabled dream；enabled 但 runner 缺失；通知副作用                       | 返回不同的明确诊断；不创建 job、不假报 started/completed                           | I    | `packages/ello-agent/tests/memory/memory-contract.test.ts`                                                                       |
| `F-GOL-01` | create/pause/resume/clear/fork；空/超长/budget；非法转换                 | 唯一 active；审计可恢复；fork 新 ID 且 paused                                      | U/I  | `packages/ello-agent/tests/goals/goal-contract.test.ts`、`packages/ello-agent/tests/thread/thread-manager.test.ts`               |
| `F-GOL-02` | Thread usage/budget；显式 update；领域 continuation；三个独立 blocker    | billable token 正确且预算只 pause；终态持久化；blocker streak 正确                 | U/I  | `packages/ello-agent/tests/goals/goal-contract.test.ts`、`packages/ello-agent/tests/thread/thread-manager.test.ts`               |
| `F-GOL-03` | write/preview/accept/chat/deny；stale hash；重复 response                | Plan 可恢复；接受进入执行；过期/重复无副作用                                       | I/E  | `packages/ello-agent/tests/e2e/process-e2e.test.ts`、`packages/ello-tui/tests/tui/OverlayHost.test.tsx`                          |

### 3.3 Workspace 与持久化

| 功能 ID    | 核心场景                                                                | 预期结果                                                      | 类型 | 测试文件                                                                                                                        |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| `F-WSP-01` | local/remote import、分层 key、fetch-local；失败补偿/保留分支           | ID/remote/mirror 稳定；local-only 语义明确；失败无残留        | I    | `packages/ello-agent/tests/workspace/workspace.test.ts`                                                                         |
| `F-WSP-02` | standard/refactor/create repo/add existing；冲突/非法 selector          | 规范路径与共同分支；registry/workspace 一致；冲突 fail fast   | I/E  | `packages/ello-agent/tests/workspace/workspace.test.ts`、`packages/ello-agent/tests/e2e/process-e2e.test.ts`                    |
| `F-WSP-03` | detached reference 生命周期；无效 ref/仍被引用                          | reference 与开发 checkout 隔离；冲突和引用保护                | I    | `packages/ello-agent/tests/workspace/workspace.test.ts`                                                                         |
| `F-WSP-04` | archive 多代/reconcile/repair；dirty/占位目录/错误 DB path              | 只诊断或安全修复；不删用户目录；多代用 ID                     | I    | `packages/ello-agent/tests/workspace/workspace.test.ts`                                                                         |
| `F-WSP-05` | delete 引用检查；local bundle round-trip；损坏 bundle/mirror 清理       | 可重建 registry；删除无悬挂；失败不产生半状态                 | I/C  | `packages/ello-agent/tests/workspace/workspace.test.ts`、`packages/ello-agent/tests/server/server-services-runtime.test.ts`     |
| `F-STO-01` | 新库/旧 `state.sqlite` 迁移/重启/close；migration drift/future/rollback | 单一 DB 和完整约束；旧 registry 导入且幂等；漂移/未来版本拒绝 | I    | `packages/ello-agent/tests/storage/storage.test.ts`                                                                             |
| `F-STO-02` | artifact dedupe/integrity/GC；checkpoint seal/rollback；漂移/故障       | 内容寻址正确；逆序恢复；preflight 失败零修改                  | I    | `packages/ello-agent/tests/storage/artifact-store.test.ts`、`packages/ello-agent/tests/storage/storage-domain-contract.test.ts` |
| `F-STO-03` | board 隔离/dependency/claim；并发/自依赖/事务失败                       | sequence 和投影一致；仅一个 owner；无半状态                   | I    | `packages/ello-agent/tests/storage/tasks.test.ts`                                                                               |
| `F-STO-04` | usage/model-call 保存聚合；缺 details/负数；隐私字段                    | 汇总正确且 cache 分离；非法拒绝；不存正文/credential          | U/I  | `packages/ello-agent/tests/storage/usage.test.ts`、`packages/ello-agent/tests/storage/storage-domain-contract.test.ts`          |
| `F-STO-05` | stable list/filter/page；item/request/compaction；seq gap/rebuild fail  | 只查 catalog；事务投影正确；失败保留旧投影                    | I    | `packages/ello-agent/tests/storage/thread-catalog.test.ts`                                                                      |

### 3.4 Thread、协议与进程

| 功能 ID    | 核心场景                                                                         | 预期结果                                                   | 类型 | 测试文件                                                                                                                                                                              |
| ---------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `F-THR-01` | 串行/并发 append；断行/seq/thread ID；第二 lease；路径穿越                       | seq 连续且可重建；损坏 fail fast；root 外文件不可触达      | I    | `packages/ello-agent/tests/thread/thread-log.test.ts`、`packages/ello-agent/tests/protocol/protocol-v1.test.ts`                                                                       |
| `F-THR-02` | start/read/list；preview/title 生成与失败；配置失败/notFound/page                | settings、preview、标题持久化；标题失败不改变 Turn 终态    | I/C  | `packages/ello-agent/tests/protocol/app-server.test.ts`、`packages/ello-agent/tests/thread/thread-manager.test.ts`、`packages/ello-agent/tests/thread/thread-title-generator.test.ts` |
| `F-THR-03` | start/delta/completed；并发 turn/空 input/终态 mutation                          | 先持久化再返回；ID 稳定；每 turn 仅一个终态                | I/E  | `packages/ello-agent/tests/thread/thread-manager.test.ts`、`packages/ello-agent/tests/e2e/process-e2e.test.ts`                                                                        |
| `F-THR-04` | steer/interrupt；stale ID/无 active；重复 interrupt                              | steer 到下一轮；interrupt 幂等；mismatch fail fast         | I/C  | `packages/ello-agent/tests/thread/thread-manager.test.ts`、`packages/ello-tui/tests/client/thread-client.test.ts`                                                                     |
| `F-THR-05` | fork 截止 turn 并继续模型；archive/unarchive/delete；非法 target                 | 新 ID 且模型历史完整；原 Thread 不变；管理状态同步         | I/E  | `packages/ello-agent/tests/thread/thread-manager.test.ts`、`packages/ello-agent/tests/e2e/process-e2e.test.ts`                                                                        |
| `F-THR-06` | active restart；旧 preview 回填；catalog drift；第二进程管理与同 Thread resume   | 未完成状态变 interrupted；旧列表可读；活跃 lease 跳过恢复  | I/E  | `packages/ello-agent/tests/thread/thread-manager.test.ts`、`packages/ello-agent/tests/e2e/process-e2e.test.ts`                                                                        |
| `F-RPC-01` | 全方法 fixture；unknown field；所有 id/envelope；schema drift                    | v1 catalog 完整 strict；wire 正反样例稳定                  | C    | `packages/ello-agent/tests/protocol/protocol-v1.test.ts`                                                                                                                              |
| `F-RPC-02` | initialize 顺序/重复/版本；握手前业务请求                                        | 协商后开放；错误 type 稳定；版本不匹配关闭                 | C    | `packages/ello-agent/tests/protocol/app-server.test.ts`                                                                                                                               |
| `F-RPC-03` | typed params/result；unknown method；configInvalid/internal                      | 领域错误可区分；响应违规独立错误；不泄露 stack/secret      | C    | `packages/ello-agent/tests/protocol/app-server.test.ts`、`packages/ello-agent/tests/config/config-response-security.test.ts`                                                          |
| `F-RPC-04` | resume barrier；连续 seq；连接隔离；慢连接                                       | response 先于 live/pending；不串线；过载只关慢连接         | C/E  | `packages/ello-agent/tests/protocol/server-connection.test.ts`、`packages/ello-agent/tests/e2e/process-e2e.test.ts`                                                                   |
| `F-RPC-05` | read/dir/metadata/search；UTF-8/artifact；穿越/外链/binary/大小；watch ownership | 结果稳定且完整内容可取；非法输入零越界；watch 不跨连接泄漏 | I/C  | `packages/ello-agent/tests/filesystem/server-file-service.test.ts`、`packages/ello-agent/tests/server/server-services-runtime.test.ts`                                                |
| `F-TRN-01` | stdio build/handshake/EOF；坏 JSON/日志；启动失败                                | stdout 纯 JSONL；连接可恢复；正常 EOF code 0               | E    | `packages/ello-agent/tests/e2e/process-e2e.test.ts`、`packages/ello-tui/tests/client/stdio-child.test.ts`                                                                             |
| `F-TRN-02` | health/token/origin/framing；坏 frame/第二连接                                   | 合法 WS 与 stdio 同语义；401/403；连接隔离                 | C/E  | `packages/ello-agent/tests/transport/listeners.test.ts`、`packages/ello-agent/tests/e2e/process-e2e.test.ts`                                                                          |
| `F-TRN-03` | Unix 0600/token/framing；已有路径/关闭清理                                       | 权限与 framing 正确；不覆盖用户路径；关闭清理              | C    | `packages/ello-agent/tests/transport/listeners.test.ts`、`packages/ello-tui/tests/client/connection.test.ts`                                                                          |
| `F-TRN-04` | outbound overload；SIGTERM active turn；重复 shutdown                            | 其他连接不阻塞；重启 interrupted；stop 幂等且 flush        | E    | `packages/ello-agent/tests/protocol/server-connection.test.ts`、`packages/ello-agent/tests/e2e/process-e2e.test.ts`                                                                   |

### 3.5 Client、CLI 与 TUI

| 功能 ID    | 核心场景                                                                 | 预期结果                                               | 类型 | 测试文件                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `F-CLT-01` | initialize gate；乱序 response；timeout；schema/Server error             | ID 正确关联；pending 清理；错误类型可区分              | C    | `packages/ello-tui/tests/client/client.test.ts`                                                                                                                                                                  |
| `F-CLT-02` | approval/user input handler；延迟接管；双击/未知/handler error           | 接管后保持 pending；response 前消费；仅第一条有效      | C    | `packages/ello-tui/tests/client/client.test.ts`、`packages/ello-tui/tests/client/thread-client.test.ts`                                                                                                          |
| `F-CLT-03` | 正常 seq；真实 gap；恢复中 submit；重复 notification                     | gap 只 resume 一次；stale 阻止 submit；不重复投影      | U/C  | `packages/ello-tui/tests/client/event-reducer.test.ts`、`packages/ello-tui/tests/client/thread-client.test.ts`                                                                                                   |
| `F-CLT-04` | local/ws/unix；close；子进程早退/非法 endpoint                           | 上层 Client 一致；资源释放；错误可诊断                 | C/E  | `packages/ello-tui/tests/client/connection.test.ts`、`packages/ello-tui/tests/client/stdio-child.test.ts`、`packages/ello-agent/tests/e2e/process-e2e.test.ts`                                                   |
| `F-CLI-01` | help/local/remote/auth；参数冲突/缺 token                                | 连接选择正确；help 无副作用；非法参数非零              | C/E  | `packages/ello-tui/tests/cli/cli-contract.test.ts`                                                                                                                                                               |
| `F-CLI-02` | no-tui text/JSON run；failed/interrupted/timeout；空 prompt              | 输出可机器读；退出语义正确；不绕审批                   | E    | `packages/ello-tui/tests/cli/cli-contract.test.ts`、`packages/ello-agent/tests/e2e/process-e2e.test.ts`                                                                                                          |
| `F-CLI-03` | 管理命令→RPC；Server error；旧命令                                       | typed method/params 正确；保留错误；removed 不读旧存储 | C    | `packages/ello-tui/tests/cli/cli-contract.test.ts`、`packages/ello-tui/tests/cli/slash-commands.test.ts`                                                                                                         |
| `F-TUI-01` | 多行/DEL/BS/移动/kill；mouse；空白/运行中 submit                         | 编辑与提交稳定；控制序列不入 buffer；运行中 steer      | U/C  | `packages/ello-tui/tests/input/composer-buffer.test.ts`、`packages/ello-tui/tests/input/composer.test.ts`                                                                                                        |
| `F-TUI-02` | `/ @ # $`；排序/frecency；profile 与文件候选；邮箱/中间词元              | 使用正确 catalog；边界不误触；只替换活动 token         | U/C  | `packages/ello-tui/tests/input/autocomplete.test.ts`、`packages/ello-tui/tests/input/completion.test.ts`、`packages/ello-tui/tests/tui/App.test.tsx`                                                             |
| `F-TUI-03` | text+`@file`；未匹配/邮箱/重复去重；fs/search error                      | 提交 text/file parts；Client 不读正文；失败不半提交    | C    | `packages/ello-tui/tests/tui/App.test.tsx`                                                                                                                                                                       |
| `F-TUI-04` | snapshot/live/usage/goal/plan/pending；replace；坏 tool result           | history/live 分层且不重复；替换清旧状态；坏数据诊断    | U/C  | `packages/ello-tui/tests/history/tui-event-store.test.ts`、`packages/ello-tui/tests/history/committed-history-store.test.ts`                                                                                     |
| `F-TUI-05` | command/file/subagent card；diff/path/artifact；空/坏 metadata           | 状态、双行号、路径与折叠正确；损坏拒绝                 | U/C  | `packages/ello-tui/tests/presentation/diff.test.ts`、`packages/ello-tui/tests/presentation/tool-card.test.ts`、`packages/ello-tui/tests/presentation/AppShell.test.tsx`                                          |
| `F-TUI-06` | 权限分类；single/multi/Other/review/chat/deny；重复/回调失败             | 风险可见但不代决策；resolution strict；可安全重试      | U/C  | `packages/ello-tui/tests/tui/permission-view.test.ts`、`packages/ello-tui/tests/tui/UserInputPanel.test.tsx`、`packages/ello-tui/tests/tui/OverlayHost.test.tsx`                                                 |
| `F-TUI-07` | picker/rewind/profile/workspace/theme；无 target/坏 profile/坏 UI config | fork 并回填；精确配置写入；主题 0600；Server summary   | C/I  | `packages/ello-tui/tests/tui/PickerList.test.tsx`、`packages/ello-tui/tests/tui/App.test.tsx`、`packages/ello-tui/tests/settings/local-ui-config.test.ts`、`packages/ello-tui/tests/tui/model-selectors.test.ts` |

### 3.6 可观测性与发布

| 功能 ID    | 核心场景                                                         | 预期结果                                                                          | 类型 | 测试文件                                                                                                                                        |
| ---------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `F-OBS-01` | 正常/失败 model call；toolset 变化；recorder flush error；隐私   | usage/fingerprint 可关联；失败可见；不记录正文/credential                         | U/I  | `packages/ello-agent/tests/observability/model-call-observer.test.ts`、`packages/ello-agent/tests/observability/observability-contract.test.ts` |
| `F-OBS-02` | tracing disabled/enabled；缺字段/凭证/非法 URL；Turn close       | 离线可运行；完整配置才给生产 Turn 注入 recorder；失败不静默降级且 exporter 被释放 | U/I  | `packages/ello-agent/tests/observability/observability-config.test.ts`、`packages/ello-agent/tests/observability/turn-tracing.test.ts`          |
| `F-REL-01` | Agent build/exports/fixture/server-entry；缺文件/internal export | 独立 Server 可启动；公开面固定；dist 漂移失败                                     | S/E  | `packages/ello-agent/tests/release/public-api.test.ts`、`packages/ello-agent/scripts/verify-dist.mjs`                                           |
| `F-REL-02` | TUI build/import zone/sensitive dependency scan；旧包 import     | 纯 Client bundle；发现 Server/AI/SQLite 依赖即失败                                | S    | `packages/ello-tui/scripts/verify-dist.mjs`、`eslint.config.js`                                                                                 |

## 4. 变更同步规则

1. 修改 `packages/*/src` 下非测试生产代码时，评审者必须指出受影响的功能 ID。
2. 功能契约变化必须在同一变更中修改 `functional-design.md` 和本文件对应行。
3. 每个受影响功能至少修改或新增一个断言可观察结果的测试；纯重排需说明为什么测试无需变化。
4. 删除测试必须在本文件“旧测试审查”或对应矩阵中说明替代覆盖，不能只因测试难维护而删除。
5. CI 运行 `pnpm contract:check`，校验两份文档功能 ID 一一对应、矩阵中的测试文件存在。
6. 发布前执行：`pnpm typecheck && pnpm lint && pnpm test && pnpm build`，随后分别执行两个包的 `verify-dist`。
