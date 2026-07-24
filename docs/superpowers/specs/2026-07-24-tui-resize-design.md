# TUI 终端窗口自适应修复设计

- 日期：2026-07-24
- 分支：`codex/fix-tui-resize`
- 范围：`@ello/tui` 包内终端尺寸不响应 resize 的根因修复

## 背景与问题

拖拽缩放终端窗口时，TUI 出现组件错误显示，输入框（Composer）尤其明显：文本换行点错位、光标位置偏移、上下键在错误的视觉行间跳动。

## 根因

项目缺少响应式的终端尺寸机制。Ink 6.8.0 在 resize 时会重绘（`ink.js` 的 `resized()` 调用 `calculateLayout()` + `onRender()`），但它只是用现有 React 树重新渲染，不会因尺寸变化触发任何组件 state 更新。因此关键在于应用代码自己把 resize 事件接入 React 的更新周期，本项目没有做这一步。

两处直接病灶：

1. `src/tui/component/AppShell.tsx` 底部的 `useTerminalSize()` 是个「假 hook」——`return { columns: process.stdout.columns ?? 100 }`，没有订阅 resize 事件、没有 `useState`。它只在 React 因别的原因 re-render 时才重读列数。
2. `src/tui/component/Composer.tsx` 第 72 行的 `wrapWidth = Math.max(1, (stdout.columns ?? 100) - 10)` 同理用过期的列数。

Composer 受影响最重，因为同一个过期的 `wrapWidth` 同时驱动三件事：文本换行（`wrapComposerLines`）、光标定位（`moveUpVisual` / `moveDownVisual`）、视觉行计数（`visualLineCount`）。三者一旦用旧列数，换行点、光标列、上下键目标行全部错位。

## 方案

采用方案 A：抽出一个真·响应式的 `useTerminalSize` hook，AppShell 与 Composer 共用，只替换数据源、不改布局算法。

被排除的备选：
- 方案 B（TerminalSizeContext Provider）：当前仅两处消费、且数据只是一个 `columns`，引入 Provider 属过度设计。未来若引入侧边栏，真正需要的是「布局模型」（分发各区域派生宽度），而非分发原始 `columns`；届时再抽 `LayoutProvider` 即可，方案 A 不阻碍这一演进。
- 方案 C（顺带统一两套换行算法）：超出「修复 resize」范围，违反「不做任务要求之外的修复」。

## 组件设计

### 新 hook：`src/tui/hooks/use-terminal-size.ts`

接口：

```ts
export interface TerminalSize {
  readonly columns: number;
}

export function useTerminalSize(): TerminalSize;
```

行为约定：
- 通过 Ink 的 `useStdout()` 获取 stdout 流（而非裸 `process.stdout`），与 Composer 现有写法一致，且让测试环境的 mock stdout 能正常工作。
- `useState` 持有当前列数，初值取 `stdout.columns ?? 100`（保留现有回退默认值）。
- `useEffect` 内监听 stdout 的 `'resize'` 事件；回调中读取当前 `stdout.columns`（再次 `?? 100` 兜底）并更新 state。
- effect 清理函数解绑监听，避免泄漏。
- 不返回 `rows`：当前无消费方，遵循 YAGNI。

与 `use-stable-input.ts` 同层，文件风格保持一致（Ink hooks + React，简洁、无冗余注释）。

### AppShell 接入

- 删除 `AppShell.tsx` 底部那个本地假 `useTerminalSize`。
- 改为 `import { useTerminalSize } from '../hooks/use-terminal-size.js'`。
- `mainWidth = Math.max(tuiTokens.width.minMain, size.columns - 2)` 计算逻辑保持不变。

### Composer 接入

- 用 `useTerminalSize()` 取响应式 `columns`，`wrapWidth = Math.max(1, size.columns - 10)`。
- 移除本文件中 `useStdout` 的使用；若 `useStdout` 不再被该文件其他代码引用，连同 import 一并移除。

`UserInputPanel.tsx` 内的两个 Composer 实例无需单独处理——它们复用同一个 Composer 组件，自动受益。

## 测试策略

resize 行为测试分两层。

### 第一层：hook 单元测试（resize 行为的主要验证）

位置：`packages/ello-tui/tests/hooks/use-terminal-size.test.ts`（与现有 `tests/` 按模块分组的约定一致）。

自建一个「columns 可控 + 可 emit resize」的 mock stdout（`EventEmitter` + 可变 `columns` 属性 + `isTTY`），通过 Ink 的 `StdoutContext.Provider` 注入，渲染一个调用该 hook 的微型组件。断言：

1. 初值取注入 stdout 的 `columns`；当 `columns` 为 `undefined` 时回退 `100`。
2. 改变 mock columns 后 `emit('resize')`，组件 state 更新为新列数。
3. 卸载组件后，mock stdout 的 listener 数量回到挂载前（验证解绑，无泄漏）。

这一层直接、可靠地验证 resize 契约本身，不依赖 `ink-testing-library` 的内部实现。

### 第二层：Composer resize 集成测试（次要）

位置：在现有 `packages/ello-tui/tests/input/composer.test.ts` 中新增用例。

`ink-testing-library` 的 mock `Stdout` 是个 `EventEmitter`（可 `emit('resize')`），但其 `columns` 是硬编码返回 `100` 的 getter、无 setter。因此在测试里改变列数需用 `Object.defineProperty` 重写 getter，再 `emit('resize')`：

```ts
Object.defineProperty(view.stdout, 'columns', { value: 40, configurable: true });
view.stdout.emit('resize');
```

断言：缩窄到 40 列后，长文本按 `40 - 10 = 30` 的宽度换行；放宽后按新宽度换行。用例会标注它对 `ink-testing-library` mock 内部实现（EventEmitter + 可配置 getter）的依赖。

### 不变的现有测试

现有 `composer.test.ts` 中期望 cursor `column: 10` 的换行用例，建立在 mock stdout `columns` 为 `undefined`、hook 回退 `100` 的前提上。新 hook 保留 `?? 100` 回退，该用例无需修改。

## 范围边界（不做的事）

- 不统一 Composer 的 `wrapComposerLines` 与 `composer-buffer.ts` 的 `visualRows` 两套换行算法（二者 rowCount 计算不一致，属潜在隐患但越出本次范围）。
- 不调整魔法数字 `columns - 2` 与 `columns - 10` 的取值与含义。
- 不改动布局结构、BottomDock、OverlayHost、UserInputPanel 的双 Composer 实例。
- 不引入 Provider / Context（理由见「方案」）。

## 验收标准

1. `pnpm --filter @ello/tui typecheck` 通过。
2. `pnpm --filter @ello/tui test` 通过，含新增的 hook 单元测试与 Composer resize 集成测试。
3. `pnpm --filter @ello/tui lint` 通过。
4. 手动验证：在终端中运行 TUI，拖拽缩放窗口后，输入框换行与光标位置随当前列数正确变化；主内容区宽度随之刷新。
