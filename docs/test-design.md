# Ello 测试策略

测试验证代码的可观察行为，而不把文档编号、目录布局或组件内部结构当作契约。功能设计由各模块目录中的文档描述，并始终服从当前源码。

## 1. 测试分层

| 类型           | 标记 | 验证内容                                             | 使用原则                                        |
| -------------- | ---- | ---------------------------------------------------- | ----------------------------------------------- |
| 纯单元测试     | U    | schema、纯状态机、解析、排序、权限矩阵               | 覆盖正常、失败和边界；不 mock 被测规则本身      |
| 领域集成测试   | I    | SQLite、JSONL、Artifact、真实 Git、文件系统          | 使用临时 root，断言提交后的外部状态和故障原子性 |
| 协议/组件测试  | C    | JSON-RPC wire、Client reducer、Ink 用户操作          | 从公开输入驱动，避免断言私有组件层级            |
| 真实进程端到端 | E    | build 产物、stdio/WebSocket/Unix、mock HTTP provider | 不绕过进程、framing、恢复和鉴权边界             |
| 静态/发布检查  | S    | package exports、依赖方向、dist 内容                 | 作为 CI 门禁，不代替运行时行为测试              |

每项行为至少覆盖一个正常场景和一个关键失败场景；涉及数值、路径、状态机、恢复或并发时，额外覆盖边界场景。跨模块能力至少包含一个 I、C 或 E 测试。

## 2. 必测边界

- `packages/ello-agent/tests/engine/*`：多轮执行、工具调度、审批、恢复和停止条件。
- `packages/ello-agent/tests/thread/*` 与 `tests/e2e/process-e2e.test.ts`：JSON-RPC、进程隔离、Thread log 与通知顺序。
- `packages/ello-agent/tests/storage/*` 与 `tests/workspace/*`：SQLite 投影、文件布局和仓储生命周期。
- `packages/ello-tui/tests/cli/*`：Commander 命令、退出码和非交互输出。
- `packages/ello-tui/tests/tui/*`、`tests/input/*`、`tests/presentation/*`：用户可见内容、键盘输入、审批和历史展示。

## 3. 类型级回归

复杂协议映射、discriminated union 和 SDK 边界在相邻的 `*.test-d.ts` 中用 `satisfies` 与 `@ts-expect-error` 固化。它们随各 package 的 `typecheck` 编译，不增加独立运行时测试框架。

## 4. 变更验收

每个改动先运行与其模块对应的测试，再运行：

```bash
pnpm typecheck
pnpm test
pnpm lint
```

涉及 TUI 的改动还需终端冒烟；涉及 CLI 启动路径的改动记录优化前后的墙钟时间。测试可以随实现移动或重命名，但不得弱化既有行为断言。
