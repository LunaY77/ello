# ello Coding Agent TUI 设计稿

本文档固化 `@ello/coding-agent` 当前 TUI 实现。当计划文字与当前代码有出入时，以后续代码为准，本文档记录当前可接受的产品设计和实现契约。

## 1. 设计结论

- TUI 属于 `packages/ello-coding-agent/src/tui/`，不再有独立 `@ello/tui` 产品边界。
- 主屏采用 **shell scrollback + live viewport + bottom dock**。
- 已提交历史只进入 shell scrollback；`AppShell` 不接收完整 transcript。
- session header 是第一条历史记录，由 `TerminalHistoryOutput` 输出，不是固定 header。
- 当前活动输出只留在 `LiveViewport`：assistant streaming、running tool、running subagent、queued steer、run status。
- composer、approval、selector、settings、session、rewind 等临时 UI 都挂在 `BottomDock`。
- theme 默认是 `tokyo-night`，色值采用 Tokyo Night Storm；组件只能使用 theme token 或 `tuiTokens`。
- tool 展示以 `buildToolCardModel()` 为视图模型源；历史和 live 两条路径可以有不同密度，但不得各自解释 tool result。
- session resume 和 rewind 都使用 bottom dock 内滚动列表，不使用主屏历史窗口。
- rewind / resume / clear 会重置 terminal scrollback，再从当前 active path 重放历史。

## 2. 目录结构

当前 TUI 目录：

```text
packages/ello-coding-agent/src/tui/
  App.tsx
  index.ts
  completion.ts
  overlay-loaders.ts

  component/
    AppShell.tsx
    LiveViewport.tsx
    BottomDock.tsx
    TerminalHistoryOutput.tsx
    Composer.tsx
    OverlayHost.tsx
    ToolActivityList.tsx

  commands/
    registry.ts

  hooks/
    use-runtime-events.ts

  presenters/
    index.ts

  store/
    autocomplete.ts
    committed-history-store.ts
    composer-buffer.ts
    diff.ts
    history-entry.ts
    history-replay.ts
    permission-view.ts
    prompt-parts.ts
    tool-card.ts
    tui-event-store.ts

  theme/
    Context.tsx
    index.ts
    themes.ts
    types.ts

  ui/
    Badges.tsx
    DiffBlock.tsx
    EmptyState.tsx
    HistoryLine.tsx
    KeyHint.tsx
    Layout.tsx
    List.tsx
    Panel.tsx
    ToolRow.tsx
    Typography.tsx
    glyphs.ts
    style-contract.ts
    surfaces.ts
    tokens.ts
```

职责边界：

- `component/`：产品组件，组合 runtime state、overlay、composer、live viewport。
- `ui/`：基础 UI primitive、glyph、token、列表、diff、panel，不访问 runtime。
- `store/`：TUI 状态、history entry、tool card model、composer buffer、history replay。
- `theme/`：主题 token 和 provider。
- `commands/`：在 slash command 之上叠加 TUI command metadata。
- `presenters/`：工具结果的细节渲染，供展开态和 diff 预览复用。

## 3. 屏幕模型

```text
shell scrollback
  session_header
  user
  assistant
  tool
  subagent
  system
  diagnostic
  separator

Ink dynamic viewport
  live assistant stream
  running tool cards
  running subagent cards
  pending steers
  working / interrupted status

bottom dock
  overlay
  composer
  footer: profile / approval mode / token usage
```

`AppShell` 只渲染 dynamic viewport 和 dock：

- `AppShell.tsx` 读取 terminal columns，使用 `tuiTokens.width.minMain` 作为最小宽度。
- `LiveViewport` 展示运行中内容。
- `BottomDock` 展示 overlay、composer 和 footer。

`TerminalHistoryOutput` 负责历史输出：

- 用 Ink `Static` 输出已提交历史。
- `resetKey` 变化时重挂 `Static`，用于 session resume / rewind / clear 后按 active path 重放。
- `useRuntimeEvents` 在 `ui.clear` 和 `session.history.loaded` 到达时清 terminal screen + scrollback，然后递增 `historyResetKey`。

## 4. History Entry

历史入口定义在 `store/history-entry.ts`：

```text
session_header
user
assistant
tool
system
subagent
separator
diagnostic
```

渲染在 `store/HistoryRenderer.tsx`：

- `session_header`：round border，标题 `>_ Ello Coding Agent`，展示 profile、directory、model、permissions。
- `user`：首行使用 `>`，后续多行使用 `|`。
- `assistant`：首行使用 `*`，后续多行缩进。
- `tool`：使用 `HistoryTool`，按 `buildToolCardModel()` 生成 headline、details、preview、diff。
- `subagent`：展示 agentName、background/foreground、status、description，最多展示最近 4 个 tool call。
- `separator`：`─ Worked for ... ─`。
- `system`：`- message`。
- `diagnostic`：`x message`。

历史 replay 在 `store/history-replay.ts`：

- assistant tool-call message 不作为 JSON 展示。
- tool result 必须能找到对应 tool call；找不到直接抛 `Tool result without tool call`。
- `entryIds` 必须保留到 user / assistant / system history entry，供 `/rewind` 使用。

## 5. Live Viewport

`component/LiveViewport.tsx` 的职责：

- 只展示尚未封口的运行态信息。
- assistant streaming 用 `*` 起始行，空白 stream 不渲染。
- running tools 交给 `ToolActivityList`。
- running subagents 展示 agentName、前后台、description、最近 4 个 tool call。
- 超过 4 个 subagent tool call 时显示 `+N earlier tool calls`。
- 运行中显示 `working Ns`。
- 中断后显示 `interrupted: ...`。
- 运行中提交的新输入作为 steer 暂存，显示在 `Messages queued for the running turn` 下。

## 6. Bottom Dock

`component/BottomDock.tsx` 固定三层：

```text
overlay
single-border composer
footer
```

footer 左侧：

- `profile / primaryModel`
- approval mode

footer 右侧：

- `inputTokens + outputTokens`，大于等于 1000 时显示 `1.2k tokens`。

approval mode 颜色：

- `bypass`：danger
- `accept-edits`：warning
- `dont-ask`：accent
- 其它：success

## 7. Composer

`component/Composer.tsx` 使用 `store/composer-buffer.ts` 管理多行文本和光标，不依赖 `TextInput`。

输入契约：

- `Enter`：提交。
- 行尾 `\` + `Enter`：插入换行并移除行尾续行符。
- `Tab`：接受当前 suggestion。
- `Up/Down`：
  - 多行内移动光标；
  - 有 suggestion 时移动 suggestion；
  - 空输入或正在浏览 history 时移动输入历史。
- `Ctrl-A/E`：行首/行尾。
- `Ctrl-K/U/W`：删除到行尾、删除到行首、删除前一个词。
- `Ctrl-C`：输入非空时清空；输入为空时交给 `onCancel()`。
- `Esc`：交给 `onEscape()`。
- mouse tracking escape sequence 不写入输入。
- `isActive=false` 时不接收输入。

suggestion：

- slash command suggestion 来自 `completion.ts` 和 `commands/registry.ts`。
- `/profiles <query>` 使用 profile 列表补全。
- `@path` file suggestion 来自 `App.tsx` 的文件扫描和 `store/autocomplete.ts` 排序。

## 8. Overlay

`component/OverlayHost.tsx` 是单层 overlay host。overlay 状态是 discriminated union：

```text
approval
models
profiles
profile-create
profile-delete-confirm
profile-detail
profile-model-catalog
help
settings
theme
agents
skills
tasks
workspace
session-selector
rewind-selector
```

共同约束：

- overlay 渲染在 bottom dock 内。
- `Esc` 由 `App.tsx` 统一关闭或返回上一级。
- 选择回调必须显式传入；不允许用 no-op 掩盖未接线的 overlay。

滚动列表使用 `ui/List.tsx` 的 `InlineSelect`：

- 支持 Up/Down。
- 支持 PageUp/PageDown。
- 支持 Home/End。
- 支持 disabled item。
- `visibleRows` 控制窗口高度。
- label 行格式：`sessions  1-6 of 18`。
- 超出窗口时显示 `scrollbar  [####------]`。

session 和 rewind：

- `/resume` 打开 `session-selector`，显示 6 行 session list。
- session label 为 `YYYY-MM-DD HH:mm  title`；缺标题时使用 lastUserText，仍缺则 `Untitled session`。
- `/rewind` 无参数时打开 `rewind-selector`，显示 6 行可 rewind user entry。
- rewind label 为 `<short-entry-id> <index> <prompt preview>`。
- `/rewind <entryId>` 仍保留直接 runtime action 路径。
- 选择 rewind target 后调用 `session.rewind(entryId)`，返回 prompt 写回 composer。

## 9. Tool 展示

当前 tool 展示以 `store/tool-card.ts` 的 `buildToolCardModel()` 为准。

输入：

- `ToolCallView`
- `CodingToolResult.metadata`
- tool input
- tool status / error

输出视图模型：

```text
status
icon
name
headline
summary
metaRight
metrics
details
outputPreview
truncationNotice
diff
hasDiff
defaultCollapsed
```

headline 规则：

- `edit` / `write`：`Edited <path> (+A -R)`。
- `ls`：`List <path>`。
- `read`：`Read <path>`。
- `grep`：`Search <pattern> in <path>`。
- `glob`：`Glob <pattern> in <path>`。
- `bash` / `kind=shell`：`Ran <command>`。
- `web_fetch` / `kind=network`：`Fetched <url>`。
- `delegate_to_subagent` / `kind=task`：`Delegate <agent>`。
- 其它：`Humanized Tool Name <summary>`。

状态和详情：

- 失败且错误信息命中 permission/deny/not allowed 时，右侧状态为 `denied`。
- 失败但非权限错误时，右侧状态为 `failed`。
- 非零 `metadata.exitCode` 显示 `exit N`。
- `metadata.durationMs` 显示 `ms`、`s` 或 `m s`。
- metrics 支持 `totalLines`、`matchCount`、`entryCount`。
- diff 存在时 details 追加 `+A/-R`。
- `metadata.truncated=true` 时追加 `truncated`，并在有 `outputPath` 时显示 full log 路径。

历史 tool 渲染：

- bash tool 使用 `• ` 前缀，其它 tool 使用两个空格缩进。
- 成功 tool 颜色为 Tokyo Night Storm `borderActive`。
- running tool 颜色为 warning。
- failed tool 颜色为 danger。
- shell output preview 只展示最多 8 行非空输出。
- diff 直接展开为 unified diff preview。

live tool 渲染：

- `ToolActivityList` 逐个渲染 `ToolCard`。
- `ToolCard` 首行：`ok|...|x headline metaRight`。
- details 显示为 `  a · b · c`。
- output preview 以 `└` 引出。
- running 显示 `working`。
- 普通成功工具默认折叠；带 diff 或失败工具默认展开。

Diff 颜色来自当前主题：

- added：`theme.diffAdded`
- removed：`theme.diffRemoved`
- hunk：`theme.markdownHeading`
- file header：`theme.textMuted`
- context：`theme.text`

## 10. Theme 和样式

默认主题是 `tokyo-night`，对应 Tokyo Night Storm：

```text
text             #c0caf5
textMuted        #565f89
panel            #1f2335
border           #3b4261
borderActive     #7aa2f7
selection         #283457
accent           #7dcfff
success          #9ece6a
warning          #e0af68
error            #f7768e
info             #7aa2f7
diffAdded        #9ece6a
diffRemoved      #f7768e
diffContext      #565f89
markdownHeading  #bb9af7
markdownCode     #7dcfff
syntaxKeyword    #bb9af7
syntaxString     #9ece6a
```

当前内置主题：

- `tokyo-night`
- `github-dark`
- `github-light`
- `catppuccin`

组件取色规则：

- 新组件优先用 `useTheme()` 读取 `TuiTheme`。
- 仍在 token primitive 下的组件使用 `tuiTokens`，其色值与 Tokyo Night Storm 对齐。
- 不直接在组件里写新 hex 色值。
- glyph 统一来自 `ui/glyphs.ts`：
  - user: `>`
  - assistant: `*`
  - running tool: `...`
  - ok tool: `ok`
  - failed tool: `x`
  - subagent / queued steer: `->`
  - approval: `!`

## 11. Runtime Event 到 TUI State

`hooks/use-runtime-events.ts` 订阅 `CodingSession`：

- runtime event 进入 `reduceTuiEvent()`。
- `run.started` 记录起始时间。
- run finished 后追加 `run.worked` separator。
- `ui.clear`：
  - 清 terminal screen + scrollback；
  - 递增 `clearCount`；
  - 递增 `historyResetKey`；
  - reducer 回到 `initialTuiEventState`。
- `session.history.loaded`：
  - 清 terminal screen + scrollback；
  - 递增 `historyResetKey`；
  - reducer 用 `messagesToHistoryEntries()` 替换 committed history。

`store/tui-event-store.ts` 约束：

- reducer 对 event union 穷尽处理；未覆盖事件走 `assertNever()`。
- completed tool 必须先有 started tool，否则抛错。
- subagent event 必须先有 subagent started，否则抛错。
- subagent 内部 tool completed 必须先有对应 tool started，否则抛错。
- `session.history.loaded` 替换 history，不追加。
- `session.rewound` 在替换后的 history 后追加 `rewound to <entryId>` system entry。

## 12. Slash Command 和 Command Registry

slash command 的事实源仍是 `src/slash-commands.ts`。

`tui/commands/registry.ts` 只叠加 UI metadata：

- stable id
- title
- group
- keywords
- shortcut

`completion.ts` 消费 command registry 生成 `/` completion，执行仍回到 `handleSlashCommand()`。

当前设计不保留独立 command palette UI；命令 metadata 已经存在，后续新增 palette 时必须复用这份 registry。

## 13. 文件和 Prompt 输入

`App.tsx` 负责产品输入语义：

- `!cmd`：调用 `session.runShell()`，结果作为 system message 展示。
- `@path`：由 `prompt-parts.ts` 解析并读取文件内容，序列化进模型输入。
- 普通输入：提交给 `session.submit()`。
- running 时普通输入变成 `session.steer()`，并在 live viewport 中显示 queued steer。

文件补全：

- 只在当前行触发 `@` token 时启用。
- 路径必须在 `runtimeConfig.cwd` 内。
- 候选来自 `readdir()`，再经 `rankCandidates()` 排序。
- 目录候选追加 `/`。

## 14. 当前验收测试

当前 TUI 相关测试覆盖：

- `AppShell.test.tsx`
  - session header 作为 committed history 输出；
  - history 在 `AppShell` 外渲染；
  - live viewport running / interrupt / queued steer；
  - subagent 最新 4 个 tool call；
  - write/edit diff 渲染。
- `PickerList.test.tsx`
  - session selector 6 行窗口和 scrollbar；
  - rewind selector entry label；
  - `InlineSelect` 有窗口边界。
- `tui-event-store.test.ts`
  - assistant delta flush；
  - history replay；
  - tool/subagent lifecycle；
  - `ui.clear` reset；
  - orphan tool result fail-fast。
- `composer.test.ts`
  - Backspace / Delete；
  - 多行输入；
  - mouse escape sequence；
  - suggestion 接受。
- `theme.test.ts`
  - theme token。
- `tool-card.test.ts`
  - tool card model。
- `command-registry.test.ts`
  - slash command 与 TUI command metadata 对齐。

## 15. 后续修改准则

- 修改 TUI 交互前先判断目标属于 history、live viewport 还是 bottom dock。
- 已提交历史不得重新进入 `AppShell`。
- 新 tool UI 必须先扩展 `buildToolCardModel()`，再考虑 presenter。
- 新 overlay 必须加入 `OverlayState` union，并传入显式回调；不写 no-op 默认值。
- 新主题必须实现完整 `TuiTheme` token。
- 新列表必须优先复用 `InlineSelect`，除非需要完全不同的输入模型。
- 新 runtime event 必须补齐 `reduceTuiEvent()`，不能静默忽略。
- session active path 变化时必须触发 history source reset，保证 shell scrollback 与当前上下文一致。
