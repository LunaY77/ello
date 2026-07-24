# TUI Markdown 渲染设计

- 日期：2026-07-24
- 状态：已通过 brainstorming，待评审
- 范围：`@ello/tui` 包

## 背景与目标

`@ello/tui` 当前不支持 markdown 渲染。assistant 的文本输出（无论交互式 TUI 还是非交互 `run` 模式）都是纯文本按行原样输出：

- 交互式 TUI 中，`HistoryRenderer.tsx` 的 `assistant` 分支用 `entry.text.split('\n')` 逐行渲染，单色无解析。
- `LiveViewport.tsx` 的 `LiveAssistantText` 同样是流式文本的逐行渲染。
- 非交互模式 `render.ts` 的 `agentMessage` 直接输出 `assistant: ${item.text}`。

theme 里预留了 `markdownHeading` / `markdownCode` / `syntaxKeyword` / `syntaxString` 四个 token（注释写着「v1 仅粗粒度」），但当前唯一用途是 diff hunk 行上色，渲染管线从未存在。docs 里也没有任何 markdown 渲染的设计文档。

本设计为 TUI 引入 markdown 渲染能力，让 assistant 输出的标题、列表、代码块、行内样式得到语义化的终端呈现。

## 范围

**只覆盖 TUI 交互模式。** 非交互 `run` / `resume` 模式不做渲染，原因：

- `--json` 模式输出 NDJSON，消费者是程序，markdown 渲染无意义。
- 纯文本模式（无 `--json`）在非 TTY 场景（管道、重定向）下原样输出即可，markdown 源码本身对人可读；加 ANSI 颜色反而污染管道输出和重定向文件。
- 分支条件 `noTui === true || !process.stdout.isTTY` 表明非交互路径天然面向管道/脚本。

## 选型

三件套：

1. **解析器：`marked`** —— `marked.Lexer.lex(src)` 产出扁平 token 数组，逐个映射成 Ink `<Text>`/`<Box>` 最直接。token 模型扁平，心智负担小；与 theme 粗粒度 token 配色策略契合；依赖轻。
2. **渲染层：自写 Ink renderer** —— 遍历 marked token，按节点类型映射成 React 节点。颜色完全走 ello theme token，名实相符。
3. **代码块语法高亮：`cli-highlight`** —— 专为终端设计，体积适中，不依赖 WASM，冷启动快。无语言标签的代码块回退单色。

排除项：现成的 `ink-markdown` 组件绕开了 theme token 自控配色；`shiki` 依赖 WASM 且冷启动慢，对 TUI 响应性要求过重；纯手写解析维护成本高、边界情况多。

## 架构与模块边界

新增模块 `packages/ello-tui/src/tui/utils/markdown/`，对外只暴露一个 React 组件，内部分两层：

```
tui/utils/markdown/
  render.ts          # 纯渲染：marked 词素分析 + token → ReactNode
  MarkdownText.tsx   # 薄组件：useTheme() 后转发给 renderMarkdown
  __tests__/         # 单测
```

### `render.ts`

暴露纯函数：

```ts
function renderMarkdown(text: string, theme: TuiTheme, options?: { streaming?: boolean }): ReactNode
```

- 不依赖 React 上下文、不调用 hook，传入 theme 直接产出节点树。
- marked 的 `Lexer` 在此调用，逐个 token 映射成 `<Text>`/`<Box>`。
- `streaming` 为真时，词素化前对文本做尾部 fence/反引号修补（见「流式容错」）。
- 任何解析抛异常时 catch 住，回退纯文本按行渲染（见「降级」）。

### `MarkdownText.tsx`

薄组件：

```tsx
function MarkdownText({ text, streaming }: { text: string; streaming?: boolean })
```

唯一职责是 `useTheme()` 取 theme 后转发给 `renderMarkdown`。接入点只认这个组件，不直接碰 marked 或 token。

### 边界

接入点只管「把 assistant 文本交给 `<MarkdownText>`」；解析、高亮、容错全部内聚在 `markdown/` 模块里。theme token 契约（所有组件只能引用语义 token）在 `render.ts` 内部遵守。

## Markdown 节点 → Ink 节点映射

`renderMarkdown` 用 `marked.Lexer` 词素化文本，遍历 token 数组映射。`paragraph` / `list_item` 内部的 inline token 递归渲染。

### 块级节点

| 节点 | 映射 |
|---|---|
| `heading`（`#`~`######`） | `<Text bold color={theme.markdownHeading}>`，不带 `#` 前缀，靠颜色 + bold 区分（v1 粗粒度，不按层级分色）。层级间空行隔开。 |
| `paragraph` | `<Text color={theme.text}>`，inline token 递归。 |
| `code`（fenced） | 调 `cli-highlight`：有 lang 按语言上色（keyword→`syntaxKeyword`、string→`syntaxString`、其余回退 `markdownCode`）；无 lang 整块 `markdownCode` 单色。整体包在 `<Box flexDirection="column">`，不画边框。 |
| `list`（ordered/unordered） | 每项一行，ordered 前缀 `1. 2. `，unordered 前缀复用 `glyphs.mutedBullet`（`-`）+ 缩进。嵌套按 `tuiTokens.space.indent`（2）递进。list item 内容按 inline token 递归。 |
| `blockquote` | 每行前缀 `> `，颜色 `theme.textMuted`。 |
| `hr` | 一行 `theme.border` 色的 `─`。 |
| `space` | 空行，用于段间距。 |

### 行内节点（inline，在 paragraph / list item 内递归）

| 节点 | 映射 |
|---|---|
| `text` | 透传，递归 inline 子 token。 |
| `strong`（`**x**`） | `<Text bold>`。 |
| `em`（`*x*`） | `<Text italic>`。 |
| `codespan` | `<Text color={theme.markdownCode}>`，不加背景（v1）。 |
| `link` | `<Text color={theme.info} underline>`，仅显示链接文字，不显示 href（v1）。 |
| `del`（`~~x~~`） | `<Text strikethrough>`。 |
| `escape` / `br` | 原样字符 / 换行。 |

### 流式容错

`LiveAssistantText` 的文本是流式增长的，会遇到未闭合的 fence（三个反引号开了没闭）或未闭合的 inline 标记。策略：在调用 `Lexer` 之前做一层轻量修补——检测尾部是否有奇数个反引号或未闭合的 fence，若有则临时补一个闭合标记喂给解析器，渲染产物不会断在半截代码块里。

此修补只在 live 路径（`streaming: true`）启用；HistoryRenderer 走完整文本，不修补。

### 降级

任何 token 解析抛异常时，`renderMarkdown` catch 住，回退到原来的纯文本按行渲染（即现状行为）。markdown 渲染永远不会让 TUI 崩溃——硬约束。

## 接入点改造

### `HistoryRenderer.tsx` 的 `assistant` 分支

完整文本，turn 完成后冻结进历史。走 `<MarkdownText>`，不开 `streaming`：

```tsx
case 'assistant':
  return (
    <Box flexDirection="column">
      <Text color={theme.text}>{`${glyphs.assistant} `}</Text>
      <MarkdownText text={entry.text} />
    </Box>
  );
```

首行 `*` 图标独立成前缀行，markdown 内容紧随其后。

### `LiveViewport.tsx` 的 `LiveAssistantText`

流式增量文本，走同一个组件但开 `streaming`：

```tsx
function LiveAssistantText({ text }: { readonly text: string }) {
  return (
    <Box flexDirection="column">
      <Text color={theme.text}>{`${glyphs.assistant} `}</Text>
      <MarkdownText text={text} streaming />
    </Box>
  );
}
```

### 不动的部分

`user` 分支（`>`/`|` 前缀）、`system`、`diagnostic`、`skill`、`tool`、`subagent` 等非 assistant 文本保持纯文本。范围控制，避免改动扩散。

## Theme token 用法

所有颜色只走 `TuiTheme` 语义 token，不写死色值。汇总：

| markdown 节点 | token |
|---|---|
| heading | `markdownHeading` + bold |
| codespan / 无 lang 代码块 | `markdownCode` |
| 代码块 keyword | `syntaxKeyword` |
| 代码块 string | `syntaxString` |
| 代码块其余 token | `markdownCode`（回退） |
| 段落正文 | `text` |
| blockquote | `textMuted` |
| hr | `border` |
| link | `info` + underline |

这印证了 theme 当初预留的四个 token 正好被本设计用满。现有四个主题（tokyo-night / github-dark / github-light / catppuccin）都已定义这些 token 的色值，无需改动主题文件。

### `cli-highlight` 主题映射

`cli-highlight` 自带主题对象，提供一个自定义 theme，把 token scope 映射到 ello token：`keyword.*` → `theme.syntaxKeyword`、`string.*` → `theme.syntaxString`、其余 scope 不设色（回退到外层 `markdownCode` 兜底）。这样高亮配色受 ello theme 控制，换主题时代码块颜色跟随变化。

## 测试策略

分三层，测试放 `tui/utils/markdown/__tests__/`，用 `ink-testing-library` render 出字符串断言：

1. **`render.ts` 纯函数单测**（核心，最多）——传固定 theme，断言 `renderMarkdown(text, theme)` 输出。覆盖：heading / paragraph / list（ordered+unordered+嵌套）/ code（带 lang）/ code（无 lang）/ codespan / strong / em / link / blockquote / hr，以及流式容错（喂半截 fence 断言不崩）和降级（喂非法输入断言回退纯文本）。
2. **`MarkdownText.tsx` 组件单测**（少量）——验证 `useTheme()` 转发、`streaming` prop 传递。
3. **接入点回归**——`ink-testing-library` render `HistoryRenderer` 和 `LiveViewport` 的 assistant 分支，断言产出 markdown 渲染节点而非旧 split-join 文本。

测试不连真实 App Server，全用 fixture 文本，快且稳定。与 ello 现有测试组织（`tests/` 按业务能力分目录、验证可观察行为）一致。

## 依赖增量

`packages/ello-tui/package.json` 的 `dependencies` 增加：

- `marked`
- `cli-highlight`

`devDependencies` 增加对应 `@types`（若 `cli-highlight` 无 bundled types）。build 脚本 `scripts/build.mjs` 无需改动。

## 非目标（YAGNI）

- 非交互模式 markdown 渲染。
- GFM 表格、脚注、任务列表等扩展语法（低频，后续可加）。
- 代码块画边框 / 背景色（v1 保持简单）。
- heading 按 `#` 层级分色（v1 粗粒度）。
- link 显示 href（v1 仅文字）。
- `user` / `system` 等非 assistant 文本的 markdown 渲染。
