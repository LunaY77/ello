import { Text } from 'ink';
import type { ReactNode } from 'react';

import { useTheme, type TuiTheme } from '../theme/index.js';

type HistoryTone =
  | 'accent'
  | 'border'
  | 'danger'
  | 'muted'
  | 'success'
  | 'text'
  | 'warning';

export function HistoryLine({
  tone = 'text',
  children,
}: {
  readonly tone?: HistoryTone;
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  return <Text color={historyToneColor(theme, tone)}>{children}</Text>;
}

function historyToneColor(theme: TuiTheme, tone: HistoryTone): string {
  switch (tone) {
    case 'accent':
      return theme.accent;
    case 'border':
      return theme.border;
    case 'danger':
      return theme.error;
    case 'muted':
      return theme.textMuted;
    case 'success':
      return theme.success;
    case 'warning':
      return theme.warning;
    case 'text':
      return theme.text;
  }
}
