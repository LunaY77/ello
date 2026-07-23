# @ello/app — ello 桌面端

ello Agent 的桌面客户端:Tauri 2 + React 19 + TypeScript(strict)+ Tailwind CSS 4 + Zustand 5。
React 层只消费 `@ello/agent/protocol` 的严格 JSON-RPC 协议,不持有 Agent 领域事实。

## 开发

```bash
# 1. 安装依赖(仓库根)
pnpm install

# 2. 构建 agent 并准备 sidecar(需要 bun)
pnpm --filter @ello/app sidecar

# 3. 启动桌面应用(Vite dev server + Tauri 窗口)
pnpm --filter @ello/app tauri dev
```

## Storybook

Storybook 使用固定 fixture 和独立 store 种子,不连接 ello-agent、Tauri 或网络服务。安装依赖后可直接从仓库根目录启动:

```bash
pnpm --filter @ello/app storybook
```

浏览器访问 <http://localhost:6006>。也可以进入 `packages/ello-app` 后执行 `pnpm storybook`。

构建可部署的静态组件站点:

```bash
pnpm --filter @ello/app build-storybook
```

默认输出目录为 `packages/ello-app/storybook-static/`。

## 构建

```bash
pnpm --filter @ello/app icons      # 生成 src-tauri/icons(首次或更换图标时)
pnpm --filter @ello/app sidecar    # 产出 src-tauri/binaries/ello-agent-<triple>
pnpm --filter @ello/app build      # WebView 产物
pnpm --filter @ello/app tauri build
```

## 架构

```text
React View
  -> feature operation (features/*/<feature>.ts)
  -> typed AppServerClient (client/app-server-client.ts)
  -> DesktopSidecarTransport (sidecar stdio)
  <- parsed snapshot / notification / Server Request
  <- single event reducer (client/event-reducer.ts)
  <- Zustand projection (store/store.ts)
  -> components render from useXXX hooks
```

- **协议边界**:只导入 `@ello/agent/protocol`;所有出入站 wire 值过 Zod schema。
- **seq 纪律**:notification 按 thread 严格连续。重复(barrier 滞留)跳过;
  未加载快照、断层或缺失引用均抛出协议违约并关闭连接,重新连接时完整重读。
- **审批**:live 到达与快照重建的 Server Request 共用持久 `srvreq_*` ID 应答路径,
  承载于 composer 上方常驻队列(不弹窗)。
- **主题**:全部色值来自 `styles/tokens.css` 的 CSS 变量,切换 `data-theme` 原子生效。

## 目录

```text
src/
  app/            Provider、路由、连接门禁、顶栏组合(composition root)
  features/       approval / command-palette / composer / files / skills /
                  settings / tasks / thread / timeline / workspace
  components/     layout(AppShell、PanelResizer、ErrorBoundary)与
                  ui(Button、Tooltip、Menu、Markdown、DiffView 等 Fluent primitives)
  client/         transport、typed RPC client、event-reducer、server-request 控制器
  store/          store.ts 状态与 useXXX hooks、types.ts 状态类型
  lib/            theme、keyboard、tauri 窄封装、format、report
  styles/         tokens.css(明暗双主题)+ globals.css
src-tauri/        sidecar 进程桥、窗口配置、capabilities
scripts/          generate-icons.mjs、prepare-sidecar.sh
```

## 验证

```bash
pnpm --filter @ello/app lint
pnpm --filter @ello/app typecheck
pnpm --filter @ello/app test
pnpm --filter @ello/app build-storybook
pnpm --filter @ello/app build
```

尚未落地(后续迭代):Playwright e2e、`tauri build` CI。
