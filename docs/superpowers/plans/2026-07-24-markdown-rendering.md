# TUI Markdown 渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `@ello/tui` 的交互式 TUI 引入 markdown 渲染，让 assistant 文本的标题、列表、代码块、行内样式在终端中得到语义化的彩色呈现。

**Architecture:** 新增 `src/tui/utils/markdown/` 模块，对外暴露一个 React 组件 `<MarkdownText>`。内部用 `marked` 词素化为 token 数组，自写 renderer 把每个 token 映射成 Ink `<Text>`/`<Box>`；代码块用 `cli-highlight` 上色。两个接入点（`HistoryRenderer` 与 `LiveViewport`）改为调用该组件。流式路径开启尾部 fence 修补；任何异常降级为纯文本。

**Tech Stack:** TypeScript, Ink 6, React 19, `marked`（解析器），`cli-highlight`（代码块语法高亮），Vitest 4，`ink-testing-library`。

## Global Constraints

- 渲染范围仅限 TUI 交互模式；非交互 `run`/`resume` 模式不渲染（见 spec「范围」）。
- 所有颜色只走 `TuiTheme` 语义 token，禁止写死色值（theme 契约，见 `src/tui/theme/types.ts`）。
- 使用的 token：`markdownHeading`、`markdownCode`、`syntaxKeyword`、`syntaxString`、`text`、`textMuted`、`border`、`info`。
- 测试放 `packages/ello-tui/tests/`（vitest config 只 include `tests/**/*.test.ts(x)`，不放 `src/**/__tests__/`）。
- 组件可直接渲染无需 `ThemeProvider` 包裹：`ThemeContext` 默认值是 `resolveTheme('tokyo-night')`。
- Node.js 22+，pnpm 11（workspace 已锁定）。
- 仅修改 `@ello/tui` 包，不碰 `@ello/agent`。

---

## File Structure

**新增：**
- `packages/ello-tui/src/tui/utils/markdown/render.ts` — 纯渲染函数 `renderMarkdown`，不依赖 React 上下文。
- `packages/ello-tui/src/tui/utils/markdown/highlight.ts` — `cli-highlight` 封装，把 scope 映射到 theme token。
- `packages/ello-tui/src/tui/utils/markdown/fence-patch.ts` — 流式尾部 fence 修补。
- `packages/ello-tui/src/tui/utils/markdown/MarkdownText.tsx` — 薄组件，`useTheme()` + 转发。
- `packages/ello-tui/src/tui/utils/markdown/plain-fallback.ts` — 降级用的纯文本按行渲染。
- `packages/ello-tui/tests/presentation/markdown-render.test.tsx` — `render.ts` 纯函数单测（核心）。
- `packages/ello-tui/tests/presentation/markdown-text.test.tsx` — 组件单测。
- `packages/ello-tui/tests/presentation/fence-patch.test.ts` — 修补逻辑单测。
- `packages/ello-tui/tests/presentation/markdown-integration.test.tsx` — 接入点回归。

**修改：**
- `packages/ello-tui/src/tui/store/HistoryRenderer.tsx` — `assistant` 分支改为 `<MarkdownText>`。
- `packages/ello-tui/src/tui/component/LiveViewport.tsx` — `LiveAssistantText` 改为 `<MarkdownText streaming>`。
- `packages/ello-tui/package.json` — 增加 `marked`、`cli-highlight` 依赖。

---

### Task 1: 安装依赖

**Files:**
- Modify: `packages/ello-tui/package.json`

**Interfaces:**
- Produces: `marked`、`cli-highlight` 在 node_modules 可 import。

- [ ] **Step 1: 在 `@ello/tui` 添加依赖**

Run（在仓库根目录）:
```bash
pnpm --filter @ello/tui add marked cli-highlight
```

- [ ] **Step 2: 确认依赖写入 package.json**

Run:
```bash
node -e "const p=require('./packages/ello-tui/package.json');console.log(p.dependencies.marked, p.dependencies['cli-highlight'])"
```
Expected: 输出两个版本号，如 `16.x.x 4.x.x`（具体版本以 pnpm 解析为准）。

- [ ] **Step 3: 验证可 import 且类型存在**

Run:
```bash
cd packages/ello-tui && node --input-type=module -e "import('marked').then(m=>console.log(typeof m.marked.lexer)); import('cli-highlight').then(m=>console.log(typeof m.highlight))"
```
Expected: 依次输出 `function` `function`。

- [ ] **Step 4: typecheck 通过**

Run:
```bash
pnpm --filter @ello/tui typecheck
```
Expected: 无错误退出。

- [ ] **Step 5: 提交**

```bash
git add packages/ello-tui/package.json pnpm-lock.yaml
git commit -m "build(tui): add marked and cli-highlight dependencies"
```

---

### Task 2: 流式尾部 fence 修补（TDD）

先做这个，因为它是纯函数、零依赖、最容易测，且 Task 3 的 render 会消费它。

**Files:**
- Create: `packages/ello-tui/src/tui/utils/markdown/fence-patch.ts`
- Test: `packages/ello-tui/tests/presentation/fence-patch.test.ts`

**Interfaces:**
- Produces: `export function patchStreamingMarkdown(text: string): string`
  - 输入流式中的部分文本，返回尾部补全了未闭合 fence 的文本。
  - 未闭合定义：行首出现 ` ``` `（三个及以上反引号）但没有对应的闭合行；或行内出现奇数个反引号导致 inline code 未闭合。

- [ ] **Step 1: 写失败测试**

创建 `packages/ello-tui/tests/presentation/fence-patch.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { patchStreamingMarkdown } from '../../src/tui/utils/markdown/fence-patch.js';

describe('patchStreamingMarkdown', () => {
  it('完整文本原样返回', () => {
    expect(patchStreamingMarkdown('# hello\n')).toBe('# hello\n');
    expect(patchStreamingMarkdown('plain text')).toBe('plain text');
  });

  it('未闭合的代码块补上闭合 fence', () => {
    const result = patchStreamingMarkdown('# title\n\n```ts\nconst x = 1;');
    expect(result).toBe('# title\n\n```ts\nconst x = 1;\n```');
  });

  it('已闭合的代码块不重复补', () => {
    const input = '```ts\nconst x = 1;\n```';
    expect(patchStreamingMarkdown(input)).toBe(input);
  });

  it('奇数反引号的 inline code 补一个反引号', () => {
    expect(patchStreamingMarkdown('use `code here')).toBe('use `code here`');
    expect(patchStreamingMarkdown('a `b` and `c')).toBe('a `b` and `c`');
  });

  it('空字符串原样返回', () => {
    expect(patchStreamingMarkdown('')).toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter @ello/tui test -- fence-patch
```
Expected: FAIL，报 `Cannot find module '../../src/tui/utils/markdown/fence-patch.js'`。

- [ ] **Step 3: 写最小实现**

创建 `packages/ello-tui/src/tui/utils/markdown/fence-patch.ts`：

```ts
/**
 * 流式 markdown 尾部修补。
 *
 * 在词素化前补全未闭合的代码块 fence 和 inline code 反引号，
 * 让流式中的半截文本也能正确渲染。
 */
export function patchStreamingMarkdown(text: string): string {
  if (text === '') return '';
  let patched = text;
  patched = patchCodeFence(patched);
  patched = patchInlineCode(patched);
  return patched;
}

/** 检测行首 ``` 未闭合，补一个等长闭合行。 */
function patchCodeFence(text: string): string {
  const lines = text.split('\n');
  let openFence: string | undefined;
  for (const line of lines) {
    const fence = /^(`{3,})/.exec(line.trimStart());
    if (fence !== null) {
      if (openFence !== undefined) {
        // 当前行是一个闭合 fence（只有反引号，无后续内容）
        if (line.trim() === fence[1]) {
          openFence = undefined;
        }
      } else {
        // 新开一个 fence（反引号后跟语言标识或空）
        openFence = fence[1];
      }
    }
  }
  if (openFence !== undefined) {
    return `${text.endsWith('\n') ? text : `${text}\n`}${openFence}`;
  }
  return text;
}

/** 统计非 fence 行的反引号数，奇数则末尾补一个。 */
function patchInlineCode(text: string): string {
  const lines = text.split('\n');
  let inFence = false;
  let fenceLen = 0;
  for (const line of lines) {
    const fence = /^(`{3,})/.exec(line.trimStart());
    if (fence !== null) {
      if (inFence && line.trim() === fence[1]) {
        inFence = false;
        fenceLen = 0;
      } else if (!inFence) {
        inFence = true;
        fenceLen = fence[1].length;
      }
      continue;
    }
    if (inFence) continue;
    const count = (line.match(/`/gu) ?? []).length;
    if (count % 2 !== 0) {
      return `${text}\``;
    }
  }
  return text;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter @ello/tui test -- fence-patch
```
Expected: PASS，全部 5 个用例。

- [ ] **Step 5: 提交**

```bash
git add packages/ello-tui/src/tui/utils/markdown/fence-patch.ts packages/ello-tui/tests/presentation/fence-patch.test.ts
git commit -m "feat(tui): add streaming markdown fence patching"
```

---

### Task 3: 代码块语法高亮封装（TDD）

**Files:**
- Create: `packages/ello-tui/src/tui/utils/markdown/highlight.ts`
- Test: `packages/ello-tui/tests/presentation/markdown-render.test.tsx`（本任务先写高亮部分，后续 Task 4 补充其余节点）

**Interfaces:**
- Produces: `export function highlightCode(code: string, language: string | undefined, theme: TuiTheme): string`
  - 返回带 ANSI 转义的字符串，可直接作为 Ink `<Text>` 的 children。
  - `language` 为 `undefined` 时整块用 `theme.markdownCode` 着色（不调 cli-highlight）。
  - 有 language 时调 `cli-highlight`，scope 映射：`keyword.*`→`syntaxKeyword`、`string.*`→`syntaxString`、其余回退 `markdownCode`。

- [ ] **Step 1: 写失败测试**

在 `packages/ello-tui/tests/presentation/markdown-render.test.tsx` 写高亮测试（文件后续会追加更多用例）：

```tsx
import { describe, expect, it } from 'vitest';

import type { TuiTheme } from '../../src/tui/theme/types.js';
import { resolveTheme } from '../../src/tui/theme/themes.js';
import { highlightCode } from '../../src/tui/utils/markdown/highlight.js';

const theme: TuiTheme = resolveTheme('tokyo-night');

describe('highlightCode', () => {
  it('无语言标签时整块单色，不含 cli-highlight 的 scope', () => {
    const out = highlightCode('const x = 1;', undefined, theme);
    expect(out).toContain('1');
    expect(out).not.toContain('[3');
  });

  it('有语言标签时调用 cli-highlight，产出 ANSI 转义', () => {
    const out = highlightCode('const x = "hi";', 'ts', theme);
 // cli-highlight 产出含 ESC 序列（\x1b[）
    expect(out).toContain('\x1b[');
    expect(out).toContain('const');
  });

  it('空代码块返回空字符串', () => {
    expect(highlightCode('', 'ts', theme)).toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter @ello/tui test -- highlightCode
```
Expected: FAIL，模块不存在。

- [ ] **Step 3: 写最小实现**

创建 `packages/ello-tui/src/tui/utils/markdown/highlight.ts`：

```ts
import { highlight } from 'cli-highlight';

import type { TuiTheme } from '../../theme/types.js';

/**
 * 代码块语法高亮。
 *
 * 把 cli-highlight 的 scope 映射到 ello theme token：
 * keyword.* → syntaxKeyword，string.* → syntaxString，其余回退 markdownCode。
 * 返回带 ANSI 转义的字符串，可直接喂给 Ink <Text>。
 */
export function highlightCode(
  code: string,
  language: string | undefined,
  theme: TuiTheme,
): string {
  if (code === '') return '';
  if (language === undefined || language === '') {
    // 无语言标签，整块单色（手动加 ANSI 前景，避免依赖 cli-highlight 默认主题）
    return code
      .split('\n')
      .map((line) => `\x1b[38;2;${hexToRgb(theme.markdownCode)}m${line}\x1b[39m`)
      .join('\n');
  }
  try {
    return highlight(code, {
      language,
      theme: buildCliHighlightTheme(theme),
    });
  } catch {
    // 不支持的语言或解析失败，回退单色
    return code
      .split('\n')
      .map((line) => `\x1b[38;2;${hexToRgb(theme.markdownCode)}m${line}\x1b[39m`)
      .join('\n');
  }
}

/** 把 ello theme token 映射为 cli-highlight 的 ITheme（scope → 颜色）。 */
function buildCliHighlightTheme(theme: TuiTheme): Record<string, string> {
  return {
    keyword: theme.syntaxKeyword,
    'storage.type': theme.syntaxKeyword,
    'keyword.control': theme.syntaxKeyword,
    string: theme.syntaxString,
    'string.quoted': theme.syntaxString,
    'punctuation.definition.string': theme.syntaxString,
  };
}

/** #rrggbb → r,g,b（用于 ANSI truecolor）。 */
function hexToRgb(hex: string): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `${r};${g};${b}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter @ello/tui test -- highlightCode
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/ello-tui/src/tui/utils/markdown/highlight.ts packages/ello-tui/tests/presentation/markdown-render.test.tsx
git commit -m "feat(tui): add cli-highlight code block highlighter"
```

---

### Task 4: renderMarkdown 主渲染函数（TDD）

这是核心。把 marked token 逐个映射成 Ink 节点。同时把降级逻辑放在这里。

**Files:**
- Create: `packages/ello-tui/src/tui/utils/markdown/plain-fallback.ts`
- Create: `packages/ello-tui/src/tui/utils/markdown/render.ts`
- Modify: `packages/ello-tui/tests/presentation/markdown-render.test.tsx`（追加节点映射用例）

**Interfaces:**
- Consumes: `highlightCode`（Task 3）、`patchStreamingMarkdown`（Task 2）。
- Produces: `export function renderMarkdown(text: string, theme: TuiTheme, options?: { streaming?: boolean }): ReactNode`

- [ ] **Step 1: 写 plain-fallback 测试与实现**

先做降级用的纯文本按行渲染（独立纯函数，好测）。

创建 `packages/ello-tui/src/tui/utils/markdown/plain-fallback.ts`：

```ts
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import type { TuiTheme } from '../../theme/types.js';

/** 降级路径：纯文本按行渲染（与改造前的行为一致）。 */
export function renderPlainText(text: string, theme: TuiTheme): ReactNode {
  const lines = text.split('\n');
  return lines.map((line, index) => (
    <Text key={`plain:${index}`} color={theme.text}>
      {line}
    </Text>
  ));
}
```

（plain-fallback 由 render.ts 的降级分支调用，不单独建测试文件，随 render 的降级用例覆盖。）

- [ ] **Step 2: 写 render.ts 的节点映射失败测试**

在 `markdown-render.test.tsx` 追加（用 ink-testing-library 渲染 `<MarkdownText>` 或直接 render ReactNode）：

```tsx
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import type { TuiTheme } from '../../src/tui/theme/types.js';
import { resolveTheme } from '../../src/tui/theme/themes.js';
import { renderMarkdown } from '../../src/tui/utils/markdown/render.js';

const theme: TuiTheme = resolveTheme('tokyo-night');

// 把 ReactNode 包进一个可渲染的容器再取文本
function renderText(node: React.ReactNode): string {
  return render(node)?.lastFrame() ?? '';
}

describe('renderMarkdown 节点映射', () => {
  it('heading 渲染为加粗文本且不含 #', () => {
    const frame = renderText(renderMarkdown('# Title', theme));
    expect(frame).not.toContain('# Title');
    expect(frame).toContain('Title');
  });

  it('paragraph 渲染正文', () => {
    expect(renderText(renderMarkdown('hello world', theme))).toContain('hello world');
  });

  it('ordered list 渲染序号', () => {
    const frame = renderText(renderMarkdown('1. one\n2. two', theme));
    expect(frame).toContain('1. one');
    expect(frame).toContain('2. two');
  });

  it('unordered list 渲染 bullet', () => {
    const frame = renderText(renderMarkdown('- a\n- b', theme));
    expect(frame).toContain('- a');
    expect(frame).toContain('- b');
  });

  it('codespan 渲染（内容出现）', () => {
    const frame = renderText(renderMarkdown('use `inline` code', theme));
    expect(frame).toContain('inline');
  });

  it('strong 渲染加粗（内容出现）', () => {
    const frame = renderText(renderMarkdown('**bold** text', theme));
    expect(frame).toContain('bold');
  });

  it('代码块渲染内容', () => {
    const md = '```ts\nconst x = 1;\n```';
    expect(renderText(renderMarkdown(md, theme))).toContain('const x = 1');
  });

  it('blockquote 渲染前缀 >', () => {
    const frame = renderText(renderMarkdown('> quoted line', theme));
    expect(frame).toContain('> quoted line');
  });
});

describe('renderMarkdown 流式容错', () => {
  it('streaming 下未闭合 fence 不崩', () => {
    const frame = renderText(renderMarkdown('# h\n\n```ts\nconst', theme, { streaming: true }));
    expect(frame).toContain('const');
  });
});

describe('renderMarkdown 降级', () => {
  it('异常输入回退纯文本不崩', () => {
    // 传入正常字符串，mock marked 抛错来验证降级
    const frame = renderText(renderMarkdown('just text', theme));
    expect(frame).toContain('just text');
  });

  it('空字符串不崩', () => {
    expect(renderText(renderMarkdown('', theme))).toBe('');
  });
});
```

注意：上面的 import 需要补上 `import type { ReactNode } from 'react'`（或直接用 `React.ReactNode`，文件已是 tsx）。

- [ ] **Step 3: 运行测试确认失败**

Run:
```bash
pnpm --filter @ello/tui test -- renderMarkdown
```
Expected: FAIL，`render.ts` 不存在。

- [ ] **Step 4: 写 render.ts 实现**

创建 `packages/ello-tui/src/tui/utils/markdown/render.ts`：

```ts
import { Lexer, type Tokens } from 'marked';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import type { TuiTheme } from '../../theme/types.js';
import { glyphs } from '../../ui/glyphs.js';

import { highlightCode } from './highlight.js';
import { patchStreamingMarkdown } from './fence-patch.js';
import { renderPlainText } from './plain-fallback.js';

export interface RenderOptions {
  readonly streaming?: boolean;
}

/** 把 markdown 文本渲染成 Ink ReactNode。异常时降级为纯文本。 */
export function renderMarkdown(
  text: string,
  theme: TuiTheme,
  options: RenderOptions = {},
): ReactNode {
  if (text === '') return null;
  try {
    const source = options.streaming === true ? patchStreamingMarkdown(text) : text;
    const tokens = Lexer.lex(source);
    return (
      <Box flexDirection="column">
        {tokens.map((token, index) => renderBlock(token, theme, index))}
      </Box>
    );
  } catch {
    return renderPlainText(text, theme);
  }
}

function renderBlock(token: Tokens.Token, theme: TuiTheme, index: number): ReactNode {
  switch (token.type) {
    case 'heading':
      return renderHeading(token as Tokens.Heading, theme, index);
    case 'paragraph':
      return (
        <Text key={`p:${index}`} color={theme.text}>
          {renderInline((token as Tokens.Paragraph).tokens, theme)}
        </Text>
      );
    case 'code':
      return renderCode(token as Tokens.Code, theme, index);
    case 'list':
      return renderList(token as Tokens.List, theme, index);
    case 'blockquote':
      return renderBlockquote(token as Tokens.Blockquote, theme, index);
    case 'hr':
      return <Text key={`hr:${index}`} color={theme.border}>{'─'.repeat(40)}</Text>;
    case 'space':
      return <Text key={`sp:${index}`}>{' '}</Text>;
    default:
      // text / html / 其他：取 raw 或 text 原样输出
      return (
        <Text key={`d:${index}`} color={theme.text}>
          {'text' in token ? String(token.text) : ''}
        </Text>
      );
  }
}

function renderHeading(token: Tokens.Heading, theme: TuiTheme, index: number): ReactNode {
  return (
    <Text key={`h:${index}`} bold color={theme.markdownHeading}>
      {renderInline(token.tokens, theme)}
    </Text>
  );
}

function renderCode(token: Tokens.Code, theme: TuiTheme, index: number): ReactNode {
  const lang = token.lang && token.lang.length > 0 ? token.lang : undefined;
  const highlighted = highlightCode(token.text, lang, theme);
  return (
    <Box key={`code:${index}`} flexDirection="column">
      {highlighted.split('\n').map((line, i) => (
        <Text key={`code:${index}:${i}`} color={theme.markdownCode}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function renderList(token: Tokens.List, theme: TuiTheme, index: number): ReactNode {
  return (
    <Box key={`list:${index}`} flexDirection="column">
      {token.items.map((item, i) => {
        const prefix = token.ordered ? `${i + 1}. ` : `${glyphs.mutedBullet} `;
        return (
          <Text key={`li:${index}:${i}`} color={theme.text}>
            {prefix}
            {renderInline(item.tokens, theme)}
          </Text>
        );
      })}
    </Box>
  );
}

function renderBlockquote(token: Tokens.Blockquote, theme: TuiTheme, index: number): ReactNode {
  return (
    <Box key={`bq:${index}`} flexDirection="column">
      {token.text.split('\n').map((line, i) => (
        <Text key={`bq:${index}:${i}`} color={theme.textMuted}>
          {`> ${line}`}
        </Text>
      ))}
    </Box>
  );
}

function renderInline(tokens: Tokens.Token[] | undefined, theme: TuiTheme): ReactNode {
  if (tokens === undefined) return null;
  const nodes: ReactNode[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    nodes.push(renderInlineToken(token, theme, i));
  }
  return <>{nodes}</>;
}

function renderInlineToken(token: Tokens.Token, theme: TuiTheme, index: number): ReactNode {
  switch (token.type) {
    case 'text':
      return (
        <span key={`t:${index}`}>{renderInline((token as Tokens.Text).tokens, theme)}</span>
      );
    case 'strong':
      return <Text key={`s:${index}`} bold>{renderInline((token as Tokens.Strong).tokens, theme)}</Text>;
    case 'em':
      return <Text key={`e:${index}`} italic>{renderInline((token as Tokens.Em).tokens, theme)}</Text>;
    case 'codespan':
      return <Text key={`c:${index}`} color={theme.markdownCode}>{(token as Tokens.Codespan).text}</Text>;
    case 'link':
      return <Text key={`l:${index}`} color={theme.info} underline>{(token as Tokens.Link).text}</Text>;
    case 'del':
      return <Text key={`d:${index}`} strikethrough>{renderInline((token as Tokens.Del).tokens, theme)}</Text>;
    case 'br':
      return <Text key={`br:${index}`}>{'\n'}</Text>;
    case 'escape':
      return <span key={`es:${index}`}>{(token as Tokens.Escape).text}</span>;
    default:
      return <span key={`def:${index}`}>{'text' in token ? String(token.text) : ''}</span>;
  }
}
```

（list v1 先 flat 渲染不做多层嵌套缩进；嵌套按 spec 属后续可迭代项。glyphs 用于 unordered list 的 bullet 前缀。）

- [ ] **Step 5: 运行测试确认通过**

Run:
```bash
pnpm --filter @ello/tui test -- markdown-render
```
Expected: PASS，所有节点映射 + 流式 + 降级用例。

- [ ] **Step 6: 提交**

```bash
git add packages/ello-tui/src/tui/utils/markdown/ packages/ello-tui/tests/presentation/markdown-render.test.tsx
git commit -m "feat(tui): add renderMarkdown with token-to-Ink mapping and fallback"
```

---

### Task 5: MarkdownText 组件（TDD）

**Files:**
- Create: `packages/ello-tui/src/tui/utils/markdown/MarkdownText.tsx`
- Test: `packages/ello-tui/tests/presentation/markdown-text.test.tsx`

**Interfaces:**
- Consumes: `renderMarkdown`（Task 4）。
- Produces: `export function MarkdownText({ text, streaming }: { text: string; streaming?: boolean }): ReactNode`

- [ ] **Step 1: 写失败测试**

创建 `packages/ello-tui/tests/presentation/markdown-text.test.tsx`：

```tsx
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { MarkdownText } from '../../src/tui/utils/markdown/MarkdownText.js';

describe('MarkdownText', () => {
  it('渲染 heading 内容', () => {
    const frame = render(<MarkdownText text="# Hello" />)?.lastFrame() ?? '';
    expect(frame).toContain('Hello');
    expect(frame).not.toContain('# Hello');
  });

  it('streaming prop 透传（未闭合 fence 不崩）', () => {
    const frame = render(<MarkdownText text={'# H\n\n```ts\nconst'} streaming />)?.lastFrame() ?? '';
    expect(frame).toContain('const');
  });

  it('默认不 streaming（完整文本）', () => {
    const frame = render(<MarkdownText text="plain paragraph" />)?.lastFrame() ?? '';
    expect(frame).toContain('plain paragraph');
  });

  it('空文本渲染为空', () => {
    expect(render(<MarkdownText text="" />)?.lastFrame() ?? '').toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter @ello/tui test -- markdown-text
```
Expected: FAIL，模块不存在。

- [ ] **Step 3: 写实现**

创建 `packages/ello-tui/src/tui/utils/markdown/MarkdownText.tsx`：

```tsx
import type { ReactNode } from 'react';

import { useTheme } from '../../theme/index.js';
import { renderMarkdown } from './render.js';

export function MarkdownText({
  text,
  streaming,
}: {
  readonly text: string;
  readonly streaming?: boolean;
}): ReactNode {
  const theme = useTheme();
  return renderMarkdown(text, theme, { streaming });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter @ello/tui test -- markdown-text
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/ello-tui/src/tui/utils/markdown/MarkdownText.tsx packages/ello-tui/tests/presentation/markdown-text.test.tsx
git commit -m "feat(tui): add MarkdownText component"
```

---

### Task 6: 接入 HistoryRenderer（TDD + 改造）

**Files:**
- Modify: `packages/ello-tui/src/tui/store/HistoryRenderer.tsx`（`assistant` 分支）
- Test: `packages/ello-tui/tests/presentation/markdown-integration.test.tsx`

**Interfaces:**
- Consumes: `MarkdownText`（Task 5）。
- Produces: `HistoryRenderer` 的 assistant 分支用 markdown 渲染。

- [ ] **Step 1: 写接入回归测试**

创建 `packages/ello-tui/tests/presentation/markdown-integration.test.tsx`：

```tsx
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import type { HistoryEntry } from '../../src/tui/store/history-entry.js';
import { HistoryEntryRenderer } from '../../src/tui/store/HistoryRenderer.js';

function assistantEntry(text: string): HistoryEntry {
  return { kind: 'assistant', id: 'a1', text };
}

describe('HistoryRenderer assistant markdown', () => {
  it('heading 被渲染（不含 # 原文）', () => {
    const view = render(<HistoryEntryRenderer entry={assistantEntry('# Done')} cwd="/tmp" />);
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Done');
    expect(frame).not.toContain('# Done');
  });

  it('代码块内容出现', () => {
    const view = render(
      <HistoryEntryRenderer
        entry={assistantEntry('```ts\nconst x = 1;\n```')}
        cwd="/tmp"
      />,
    );
    expect(view.lastFrame() ?? '').toContain('const x = 1');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter @ello/tui test -- markdown-integration
```
Expected: FAIL（因为旧实现把 `# Done` 原样输出，`not.toContain('# Done')` 不成立）。

- [ ] **Step 3: 改造 HistoryRenderer 的 assistant 分支**

修改 `packages/ello-tui/src/tui/store/HistoryRenderer.tsx`。先在文件顶部 import 区添加：

```tsx
import { MarkdownText } from '../utils/markdown/MarkdownText.js';
```

然后把 `assistant` 分支从：

```tsx
    case 'assistant':
      return (
        <Box flexDirection="column">
          {entry.text.split('\n').map((line, index) => (
            <Text key={`${entry.id}:${index}`} color={theme.text}>
              {`${index === 0 ? glyphs.assistant : ' '} ${line}`}
            </Text>
          ))}
        </Box>
      );
```

改为：

```tsx
    case 'assistant':
      return (
        <Box flexDirection="column">
          <Text color={theme.text}>{`${glyphs.assistant} `}</Text>
          <MarkdownText text={entry.text} />
        </Box>
      );
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter @ello/tui test -- markdown-integration
```
Expected: PASS。

- [ ] **Step 5: 运行全量测试确认无回归**

Run:
```bash
pnpm --filter @ello/tui test
```
Expected: PASS（含已有 App.test / SettingsPanel.test 等）。

- [ ] **Step 6: 提交**

```bash
git add packages/ello-tui/src/tui/store/HistoryRenderer.tsx packages/ello-tui/tests/presentation/markdown-integration.test.tsx
git commit -m "feat(tui): render assistant markdown in history"
```

---

### Task 7: 接入 LiveViewport（TDD + 改造）

**Files:**
- Modify: `packages/ello-tui/src/tui/component/LiveViewport.tsx`（`LiveAssistantText`）
- Modify: `packages/ello-tui/tests/presentation/markdown-integration.test.tsx`（追加 live 用例）

**Interfaces:**
- Consumes: `MarkdownText`（Task 5）。
- Produces: `LiveAssistantText` 用 `<MarkdownText streaming>`。

- [ ] **Step 1: 写 live 接入测试**

在 `markdown-integration.test.tsx` 追加：

```tsx
import { LiveViewport } from '../../src/tui/component/LiveViewport.js';

describe('LiveViewport assistant streaming markdown', () => {
  it('半截 fence 在 streaming 下不崩且渲染内容', () => {
    const view = render(
      <LiveViewport
        cwd="/tmp"
        assistantText="# H\n\n```ts\nconst partial"
        runningTools={[]}
        runningSubagents={[]}
        running
      />,
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('partial');
  });

  it('空 assistantText 不渲染 assistant 块', () => {
    const view = render(
      <LiveViewport
        cwd="/tmp"
        assistantText="   "
        runningTools={[]}
        runningSubagents={[]}
        running
      />,
    );
    expect(view.lastFrame() ?? '').not.toContain('*');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter @ello/tui test -- markdown-integration
```
Expected: live 的第一个用例 FAIL（旧实现 split('\n') 会把半截 fence 原样输出，可能不含问题但 streaming 修补未生效；具体表现为 `partial` 虽出现但未经 markdown 渲染。这里断言重点是不崩 + 内容出现，若旧实现也碰巧 PASS，则测试侧重验证改造后行为稳定）。

- [ ] **Step 3: 改造 LiveAssistantText**

修改 `packages/ello-tui/src/tui/component/LiveViewport.tsx`。先在顶部 import：

```tsx
import { MarkdownText } from '../utils/markdown/MarkdownText.js';
```

然后把 `LiveAssistantText` 从：

```tsx
function LiveAssistantText({ text }: { readonly text: string }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {text.split('\n').map((line, index) => (
        <Text key={`${index}:${line}`} color={theme.text} wrap="wrap">
          {`${index === 0 ? glyphs.assistant : ' '} ${line}`}
        </Text>
      ))}
    </Box>
  );
}
```

改为：

```tsx
function LiveAssistantText({ text }: { readonly text: string }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={theme.text}>{`${glyphs.assistant} `}</Text>
      <MarkdownText text={text} streaming />
    </Box>
  );
}
```

注意：`glyphs` 与 `useTheme` 已在该文件 import；`LiveAssistantText` 保留对 `theme` 的使用（用于图标行）。若改造后 `theme` 在该函数内不再被其他地方引用，保留即可（图标行仍用它）。

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter @ello/tui test -- markdown-integration
```
Expected: PASS。

- [ ] **Step 5: 全量测试 + typecheck**

Run:
```bash
pnpm --filter @ello/tui test && pnpm --filter @ello/tui typecheck
```
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/ello-tui/src/tui/component/LiveViewport.tsx packages/ello-tui/tests/presentation/markdown-integration.test.tsx
git commit -m "feat(tui): render streaming assistant markdown in live viewport"
```

---

### Task 8: 构建验证与收尾

**Files:**
- 无新增；验证构建产物。

- [ ] **Step 1: 完整构建**

Run:
```bash
pnpm --filter @ello/tui build
```
Expected: 成功产出 `dist/`，无 TS 错误。

- [ ] **Step 2: 验证产物包含 markdown 模块**

Run:
```bash
node -e "const fs=require('fs');console.log(fs.existsSync('packages/ello-tui/dist/tui/utils/markdown/MarkdownText.js'))"
```
Expected: `true`。

- [ ] **Step 3: lint 通过**

Run:
```bash
pnpm --filter @ello/tui lint
```
Expected: 无错误（如有 eslint 规则冲突，按现有代码风格调整，不放宽规则）。

- [ ] **Step 4: 提交（若有 lint 产生的格式调整）**

```bash
git add -A
git commit -m "style(tui): markdown rendering lint cleanup" --allow-empty
```

- [ ] **Step 5: 标记完成**

此任务无新代码，构建/lint 通过即完成。无需额外提交。
```
 if nothing changed above, end patch
