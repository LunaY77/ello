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
  return renderMarkdown(
    text,
    theme,
    streaming === true ? { streaming: true } : {},
  );
}
