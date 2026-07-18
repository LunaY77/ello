# Ello Agent Client/Server 测试说明

本文档是 `docs/ello-agent-client-server-refactor-plan.md` 的验收索引。每条样例都对应当前仓库中的自动化测试；真实进程样例会先构建 `@ello/agent`，再从 `dist/server/entry.js` 启动独立 Server，不通过 in-process adapter 绕过 JSON-RPC。

## 1. Agent、配置与存储

### 1.1 配置唯一语义

- 功能：读取、按 source 写入全局 YAML，并拒绝项目级 profile 和旧 snake_case 运行键。
- 预期：只接受 `initial_mode`、`bypass_enabled` 等 snake_case schema；未知模型、错误 source 和 camelCase 旧键直接报错，不走兼容分支。
- 代码位置：`packages/ello-agent/src/__tests__/config.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/config.test.ts`。

### 1.2 权限规则

- 功能：按最后命中规则计算权限，并把项目批准规则写成带类型元数据的 YAML。
- 预期：无匹配时返回 `ask`；持久化结果可重新读取，不在 Client 侧复制权限判断。
- 代码位置：`packages/ello-agent/src/__tests__/permissions.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/permissions.test.ts`。

### 1.3 单一数据库路径

- 功能：初始化全局 Coding Storage。
- 预期：只创建 `state/ello.sqlite`，启用规定 PRAGMA；关闭后继续访问直接失败，不读取旧数据库路径。
- 代码位置：`packages/ello-agent/src/__tests__/storage.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/storage.test.ts`。

### 1.4 数据库 migration

- 功能：由 Drizzle migrator 应用生成的 baseline。
- 预期：新库只登记一次 Drizzle journal，并创建完整 table、index、foreign key 和 trigger。
- 代码位置：`packages/ello-agent/src/__tests__/storage.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/storage.test.ts`。

### 1.5 Thread JSONL

- 功能：以单 writer 串行写入 Thread/Turn/Item 记录并重建 snapshot。
- 预期：并发 append 仍产生连续 `seq`；断行、seq 跳跃、错误 thread id 和第二个 active lease 都被拒绝。
- 代码位置：`packages/ello-agent/src/__tests__/thread-log.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/thread-log.test.ts`。

### 1.6 Thread Catalog

- 功能：从已提交 JSONL record 事务化更新 SQLite 查询投影。
- 预期：排序、cwd 过滤、分页稳定；item delta、pending request 和 compaction 投影正确；seq 跳跃不污染旧状态。
- 代码位置：`packages/ello-agent/src/__tests__/thread-catalog.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/thread-catalog.test.ts`。

### 1.7 Transcript 同源写入

- 功能：Engine transcript 通过 ThreadLogRepository 的同一 writer 落盘。
- 预期：transcript 与 runtime record 共享连续 seq；nested `undefined` 按 JSON 语义清理，不可 JSON 序列化值直接失败。
- 代码位置：`packages/ello-agent/src/__tests__/transcript-store.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/transcript-store.test.ts`。

### 1.8 Thread 生命周期与恢复

- 功能：管理并行 thread、单 thread mutation、fork、archive 和 restart recovery。
- 预期：不同 thread 不串线；同一 thread 只允许一个 active turn；fork 不修改原 thread；重启把未完成 turn/item 标成 interrupted 并清理失效 pending request。
- 代码位置：`packages/ello-agent/src/__tests__/thread-manager.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/thread-manager.test.ts`。

### 1.9 Artifact、Task 与 Workspace

- 功能：验证 artifact 去重校验、task board 事务和 workspace/repo 完整生命周期。
- 预期：artifact 最后引用释放后删除；task claim 竞争只有一个 owner；workspace dirty/delete/reference/repair 路径均按 Server 规则 fail fast。
- 代码位置：`packages/ello-agent/src/__tests__/artifact-store.test.ts`、`packages/ello-agent/src/__tests__/tasks.test.ts`、`packages/ello-agent/src/__tests__/workspace.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/artifact-store.test.ts src/__tests__/tasks.test.ts src/__tests__/workspace.test.ts`。

## 2. 协议与 Server

### 2.1 Protocol v1 fixture

- 功能：固定完整 Client Request、Server Notification、Server Request 目录和 wire sample。
- 预期：任何 method/schema 增删都会触发 fixture drift；unknown field 被 strict schema 拒绝。
- 代码位置：`packages/ello-agent/src/protocol/v1/fixtures/catalog.json`、`packages/ello-agent/src/__tests__/protocol-v1.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/protocol-v1.test.ts`。

### 2.2 Initialize gate

- 功能：执行 `initialize` → `initialized` 握手并路由 typed JSON-RPC。
- 预期：握手前业务请求、重复 initialize、协议版本不匹配、未知 method 和 strict params 违规都返回稳定结构化错误。
- 代码位置：`packages/ello-agent/src/__tests__/app-server.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/app-server.test.ts`。

### 2.3 Resume response barrier

- 功能：同一连接在 `thread/resume` 时排队 notification 和 pending Server Request。
- 预期：先发送 resume response，再释放 snapshot 之后的 live notification 和 pending request；Client 不会看到 response 之前的竞态事件。
- 代码位置：`packages/ello-agent/src/__tests__/server-connection.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/server-connection.test.ts`。

### 2.4 慢连接背压

- 功能：限制每条连接的 outbound queue。
- 预期：慢连接超过上限后被主动关闭，不静默丢弃终态消息，也不阻塞其它连接。
- 代码位置：`packages/ello-agent/src/__tests__/server-connection.test.ts`、`packages/ello-agent/src/__tests__/process-e2e.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/server-connection.test.ts src/__tests__/process-e2e.test.ts`。

### 2.5 TCP/WebSocket listener

- 功能：提供 health、Bearer auth、Origin 校验和 WebSocket JSON-RPC framing。
- 预期：health 可读；缺少或错误 token 返回 401；不允许的 Origin 被拒绝；认证连接进入统一 request processor。
- 代码位置：`packages/ello-agent/src/__tests__/listeners.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/listeners.test.ts`。

### 2.6 Unix socket listener

- 功能：通过 Unix socket 承载 HTTP Upgrade 后的 WebSocket JSON-RPC。
- 预期：socket 权限为 `0600`，Bearer auth 生效，framing 与 TCP listener 一致。
- 代码位置：`packages/ello-agent/src/__tests__/listeners.test.ts`、`packages/ello-tui/src/__tests__/connection.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/listeners.test.ts && pnpm --filter @ello/tui exec vitest run src/__tests__/connection.test.ts`。

### 2.7 Stdio 独立进程

- 功能：从 build 产物启动 stdio Server，完成握手和 EOF 关停。
- 预期：stdout 每行都是 JSON-RPC；日志只写 stderr；stdin EOF 后进程以 code 0 退出。
- 代码位置：`packages/ello-agent/src/__tests__/process-e2e.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/process-e2e.test.ts`。

### 2.8 Active turn 关停恢复

- 功能：在等待审批的 active turn 上向真实 Server 发送 SIGTERM，再启动新 Server 读取同一 root。
- 预期：原进程优雅退出；重启后的 authoritative turn 和 thread 都是 interrupted，pending request 已明确取消，不能伪造成 completed/failed。
- 代码位置：`packages/ello-agent/src/__tests__/process-e2e.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/process-e2e.test.ts`。

### 2.9 完整真实 Turn

- 功能：真实 WebSocket 进程通过 mock HTTP provider 执行 command、file change、request_user_input 和 assistant stream。
- 预期：命令/文件审批与用户输入都走 Server Request；assistant delta 和最终 item 可读；文件真实写入；turn 最终 completed。
- 代码位置：`packages/ello-agent/src/__tests__/process-e2e.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/process-e2e.test.ts`。

### 2.10 断线、恢复与公开 seq

- 功能：审批 pending 时断开 controller，再用 `thread/resume` 接管。
- 预期：resume response 先于 pending request replay；后续每条公开 notification 的 seq 连续；transcript、内容替换和 request 创建通过 `thread/sequence/advanced` 推进序号，不产生假 gap。
- 代码位置：`packages/ello-agent/src/server/runtime/thread-runtime.ts`、`packages/ello-agent/src/__tests__/process-e2e.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/process-e2e.test.ts`。

### 2.11 管理 RPC 与连接隔离

- 功能：在真实进程中调用 config/model/goal/task/workspace/repo RPC，并同时连接第二个 Client。
- 预期：管理结果来自 Server；第二个 Client 看不到未订阅 thread 的事件；fork snapshot 正确；`server/shutdown` code 0 退出。
- 代码位置：`packages/ello-agent/src/__tests__/process-e2e.test.ts`。
- 验证命令：`pnpm --filter @ello/agent exec vitest run src/__tests__/process-e2e.test.ts`。

## 3. Client 与 TUI

### 3.1 AppServerClient

- 功能：维护 initialize gate、pending request map、typed response 和 Server Request handler。
- 预期：乱序 response 按 id 正确关联；timeout 清理 pending；Server error 与 response schema error 可区分；Server Request 只交给显式 handler。
- 代码位置：`packages/ello-tui/src/__tests__/client.test.ts`。
- 验证命令：`pnpm --filter @ello/tui exec vitest run src/__tests__/client.test.ts`。

### 3.2 ThreadClient gap recovery

- 功能：严格比较 thread notification seq 并自动恢复 stale snapshot。
- 预期：内部记录的 sequence notification 正常推进 seq；真实 gap 只触发一次 `thread/resume`；恢复完成前禁止 submit。
- 代码位置：`packages/ello-tui/src/__tests__/event-reducer.test.ts`、`packages/ello-tui/src/__tests__/thread-client.test.ts`。
- 验证命令：`pnpm --filter @ello/tui exec vitest run src/__tests__/event-reducer.test.ts src/__tests__/thread-client.test.ts`。

### 3.3 Timeline 投影

- 功能：从 snapshot 和 typed notification 投影 committed history、live item、usage、goal、plan、pending interaction。
- 预期：item lifecycle 不重复；command delta 进入对应 tool；Server Request 保持 pending 直到显式 resolution；snapshot replacement 清空旧 live 状态。
- 代码位置：`packages/ello-tui/src/__tests__/tui-event-store.test.ts`。
- 验证命令：`pnpm --filter @ello/tui exec vitest run src/__tests__/tui-event-store.test.ts`。

### 3.4 Composer

- 功能：处理多行输入、光标、历史、backspace、mouse sequence 和 suggestion。
- 预期：提交保留完整多行文本；终端控制序列不进入输入；suggestion 只替换活动 token；overlay 打开时 Composer 停止接收输入。
- 代码位置：`packages/ello-tui/src/tui/App.tsx`、`packages/ello-tui/src/__tests__/composer.test.ts`、`packages/ello-tui/src/__tests__/App.test.tsx`。
- 验证命令：`pnpm --filter @ello/tui exec vitest run src/__tests__/composer.test.ts src/__tests__/App.test.tsx`。

### 3.5 Profile 与 Workspace overlay

- 功能：展示 Server 返回的 workspace summary，并发出 profile create/delete/activate/role-binding 意图。
- 预期：所有 Overlay 回调显式接线；workspace 不读本地数据库；profile 操作返回明确 name/role/model，不在组件内直接写配置。
- 代码位置：`packages/ello-tui/src/__tests__/OverlayHost.test.tsx`。
- 验证命令：`pnpm --filter @ello/tui exec vitest run src/__tests__/OverlayHost.test.tsx`。

### 3.6 Workspace typed RPC

- 功能：在 TUI 执行 `/workspace`。
- 预期：App 只调用 `workspace/list`，并显示 Server 返回的 workspace path。
- 代码位置：`packages/ello-tui/src/__tests__/App.test.tsx`。
- 验证命令：`pnpm --filter @ello/tui exec vitest run src/__tests__/App.test.tsx`。

### 3.7 Rewind

- 功能：将 user history entry 映射到所属 turn 后执行 `/rewind <entryId>`。
- 预期：调用 `thread.fork(turnId)`；关闭旧 ThreadClient；切换到新 thread；把原 prompt 回填 Composer；原历史不被修改。
- 代码位置：`packages/ello-tui/src/tui/App.tsx`、`packages/ello-tui/src/__tests__/App.test.tsx`、`packages/ello-tui/src/__tests__/PickerList.test.tsx`。
- 验证命令：`pnpm --filter @ello/tui exec vitest run src/__tests__/App.test.tsx src/__tests__/PickerList.test.tsx`。

### 3.8 Profile 精确写入

- 功能：创建、删除、激活 profile，并绑定 profile role model。
- 预期：分别写入 `profile.<name>`、删除 `profile.<name>`、写 `active_profile`、写 `profile.<name>.models.<role>`；全部通过 `config/write` 的 global source，不覆盖无关配置。
- 代码位置：`packages/ello-tui/src/tui/App.tsx`、`packages/ello-tui/src/__tests__/App.test.tsx`。
- 验证命令：`pnpm --filter @ello/tui exec vitest run src/__tests__/App.test.tsx`。

### 3.9 Theme 本地持久化

- 功能：选择主题并保存 Client 显示偏好。
- 预期：以 `0600` 原子写入 `<ELLO_HOME>/tui.json`；文件只接受 UI schema；不调用 Server `config/write`，也不允许 provider 等 Server-owned 字段。
- 代码位置：`packages/ello-tui/src/config/local-ui-config.ts`、`packages/ello-tui/src/__tests__/local-ui-config.test.ts`、`packages/ello-tui/src/__tests__/App.test.tsx`。
- 验证命令：`pnpm --filter @ello/tui exec vitest run src/__tests__/local-ui-config.test.ts src/__tests__/App.test.tsx`。

### 3.10 TUI 布局与工具展示

- 功能：渲染 committed history、live viewport、bottom dock、tool card、diff、session picker 和 rewind picker。
- 预期：历史不混入 live viewport；路径按 cwd 紧凑显示；diff 保留双行号；picker 窗口和 scrollbar 符合设计文档。
- 代码位置：`packages/ello-tui/src/__tests__/AppShell.test.tsx`、`packages/ello-tui/src/__tests__/tool-card.test.ts`、`packages/ello-tui/src/__tests__/PickerList.test.tsx`。
- 验证命令：`pnpm --filter @ello/tui exec vitest run src/__tests__/AppShell.test.tsx src/__tests__/tool-card.test.ts src/__tests__/PickerList.test.tsx`。

## 4. 发布与全仓门禁

### 4.1 Agent 发布产物

- 功能：构建独立 Server、protocol fixture 和批准的 package exports。
- 预期：`dist/server/entry.js` 可独立启动；protocol fixture 被复制；package 不暴露已删除的旧 SDK 入口。
- 代码位置：`packages/ello-agent/scripts/build.mjs`、`packages/ello-agent/scripts/verify-dist.mjs`、`packages/ello-agent/package.json`。
- 验证命令：`pnpm --filter @ello/agent build && pnpm --filter @ello/agent verify-dist`。

### 4.2 TUI 发布边界

- 功能：构建纯 Client CLI/TUI 产物并扫描依赖边界。
- 预期：TUI bundle 不包含 `better-sqlite3`、AI SDK、Server runtime、provider credential 或旧 `@ello/coding-agent` 代码。
- 代码位置：`packages/ello-tui/scripts/build.mjs`、`packages/ello-tui/scripts/verify-dist.mjs`、`eslint.config.js`。
- 验证命令：`pnpm --filter @ello/tui build && pnpm --filter @ello/tui verify-dist`。

### 4.3 全仓验收

- 功能：执行两个产品包和根 workspace 的全部静态、测试与构建检查。
- 预期：所有命令退出 0，`git diff --check` 无输出，暂存区为空；全仓不再出现旧 runtime/protocol 的 production import。
- 代码位置：根 `package.json`、`eslint.config.js`、两个 package 的 `package.json`。
- 验证命令：

```bash
pnpm --filter @ello/agent typecheck
pnpm --filter @ello/agent lint
pnpm --filter @ello/agent test
pnpm --filter @ello/agent build
pnpm --filter @ello/agent verify-dist
pnpm --filter @ello/tui typecheck
pnpm --filter @ello/tui lint
pnpm --filter @ello/tui test
pnpm --filter @ello/tui build
pnpm --filter @ello/tui verify-dist
pnpm build
pnpm typecheck
pnpm lint
pnpm test
git diff --check
git diff --cached --name-only
```
