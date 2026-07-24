import { Text } from 'ink';
import { createElement, type ReactNode } from 'react';

import type { TuiTheme } from '../../theme/types.js';

/** 降级路径：纯文本按行渲染（与改造前的行为一致）。 */
export function renderPlainText(text: string, theme: TuiTheme): ReactNode {
  const lines = text.split('\n');
  return lines.map((line, index) =>
    createElement(Text, { key: `plain:${index}`, color: theme.text }, line),
  );
}
