import { Box, Text } from 'ink';
import { Lexer, type Token, type Tokens } from 'marked';
import { type ReactNode, createElement, Fragment } from 'react';

import type { TuiTheme } from '../../theme/types.js';
import { glyphs } from '../../ui/glyphs.js';
import { tuiTokens } from '../../ui/tokens.js';

import { patchStreamingMarkdown } from './fence-patch.js';
import { highlightCode } from './highlight.js';
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
    const source =
      options.streaming === true ? patchStreamingMarkdown(text) : text;
    const tokens = Lexer.lex(source);
    return createElement(
      Box,
      { flexDirection: 'column' },
      ...tokens.map((token, index) => renderBlock(token, theme, index)),
    );
  } catch {
    return renderPlainText(text, theme);
  }
}

function renderBlock(token: Token, theme: TuiTheme, index: number): ReactNode {
  switch (token.type) {
    case 'heading':
      return renderHeading(token as Tokens.Heading, theme, index);
    case 'paragraph':
      return createElement(
        Text,
        { key: `p:${index}`, color: theme.text },
        renderInline((token as Tokens.Paragraph).tokens, theme),
      );
    case 'code':
      return renderCode(token as Tokens.Code, theme, index);
    case 'list':
      return renderList(token as Tokens.List, theme, String(index));
    case 'blockquote':
      return renderBlockquote(token as Tokens.Blockquote, theme, index);
    case 'hr':
      return createElement(
        Text,
        { key: `hr:${index}`, color: theme.border },
        '─'.repeat(40),
      );
    case 'space':
      return createElement(Text, { key: `sp:${index}` }, ' ');
    default: {
      // text / html / 其他：取 text 字段原样输出
      const content =
        'text' in token && typeof token.text === 'string' ? token.text : '';
      return createElement(
        Text,
        { key: `d:${index}`, color: theme.text },
        content,
      );
    }
  }
}

function renderHeading(
  token: Tokens.Heading,
  theme: TuiTheme,
  index: number,
): ReactNode {
  return createElement(
    Text,
    { key: `h:${index}`, bold: true, color: theme.markdownHeading },
    renderInline(token.tokens, theme),
  );
}

function renderCode(
  token: Tokens.Code,
  theme: TuiTheme,
  index: number,
): ReactNode {
  const lang =
    token.lang !== undefined && token.lang.length > 0 ? token.lang : undefined;
  const highlighted = highlightCode(token.text, lang, theme);
  const lines = highlighted.split('\n');
  return createElement(
    Box,
    { key: `code:${index}`, flexDirection: 'column' },
    ...lines.map((line, i) =>
      createElement(
        Text,
        { key: `code:${index}:${i}`, color: theme.markdownCode },
        line,
      ),
    ),
  );
}

function renderList(
  token: Tokens.List,
  theme: TuiTheme,
  key: string,
  indent = 0,
): ReactNode {
  return createElement(
    Box,
    {
      key: `list:${key}`,
      flexDirection: 'column',
      ...(indent > 0 ? { marginLeft: indent } : {}),
    },
    ...token.items.map((item, itemIndex) => {
      const inlineTokens = item.tokens.filter(
        (itemToken) => itemToken.type !== 'list',
      );
      const nestedLists = item.tokens.filter(
        (itemToken): itemToken is Tokens.List => itemToken.type === 'list',
      );
      const prefix = token.ordered
        ? `${(typeof token.start === 'number' ? token.start : 1) + itemIndex}. `
        : `${glyphs.mutedBullet} `;
      return createElement(
        Box,
        { key: `li:${key}:${itemIndex}`, flexDirection: 'column' },
        createElement(
          Text,
          { color: theme.text },
          prefix,
          renderInline(inlineTokens, theme),
        ),
        ...nestedLists.map((nestedList, nestedIndex) =>
          renderList(
            nestedList,
            theme,
            `${key}:${itemIndex}:${nestedIndex}`,
            tuiTokens.space.indent,
          ),
        ),
      );
    }),
  );
}

function renderBlockquote(
  token: Tokens.Blockquote,
  theme: TuiTheme,
  index: number,
): ReactNode {
  const lines = token.text.split('\n');
  return createElement(
    Box,
    { key: `bq:${index}`, flexDirection: 'column' },
    ...lines.map((line, i) =>
      createElement(
        Text,
        { key: `bq:${index}:${i}`, color: theme.textMuted },
        `> ${line}`,
      ),
    ),
  );
}

function renderInline(
  tokens: readonly Token[] | undefined,
  theme: TuiTheme,
): ReactNode {
  if (tokens === undefined) return null;
  return createElement(
    Fragment,
    null,
    ...tokens.map((token, index) => renderInlineToken(token, theme, index)),
  );
}

function renderInlineToken(
  token: Token,
  theme: TuiTheme,
  index: number,
): ReactNode {
  switch (token.type) {
    case 'text': {
      const textToken = token as Tokens.Text;
      return createElement(
        Fragment,
        { key: `t:${index}` },
        renderInline(textToken.tokens, theme) ?? textToken.text,
      );
    }
    case 'strong':
      return createElement(
        Text,
        { key: `s:${index}`, bold: true },
        renderInline((token as Tokens.Strong).tokens, theme),
      );
    case 'em':
      return createElement(
        Text,
        { key: `e:${index}`, italic: true },
        renderInline((token as Tokens.Em).tokens, theme),
      );
    case 'codespan':
      return createElement(
        Text,
        { key: `c:${index}`, color: theme.markdownCode },
        (token as Tokens.Codespan).text,
      );
    case 'link':
      return createElement(
        Text,
        { key: `l:${index}`, color: theme.info, underline: true },
        (token as Tokens.Link).text,
      );
    case 'del':
      return createElement(
        Text,
        { key: `del:${index}`, strikethrough: true },
        renderInline((token as Tokens.Del).tokens, theme),
      );
    case 'br':
      return createElement(Text, { key: `br:${index}` }, '\n');
    case 'escape':
      return createElement(
        Fragment,
        { key: `es:${index}` },
        (token as Tokens.Escape).text,
      );
    default: {
      const content =
        'text' in token && typeof token.text === 'string' ? token.text : '';
      return createElement(Fragment, { key: `def:${index}` }, content);
    }
  }
}
