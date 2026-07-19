import { Text } from 'ink';

import { useTheme, type TuiTheme } from '../theme/index.js';

export function StatusBadge({
  label,
  tone,
}: {
  readonly label: string;
  readonly tone: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const theme = useTheme();
  return <Text color={toneColor(theme, tone)}>{label}</Text>;
}

export const ModelBadge = StatusBadge;
export const PermissionBadge = StatusBadge;

function toneColor(
  theme: TuiTheme,
  tone: 'neutral' | 'success' | 'warning' | 'danger',
): string {
  switch (tone) {
    case 'neutral':
      return theme.textMuted;
    case 'success':
      return theme.success;
    case 'warning':
      return theme.warning;
    case 'danger':
      return theme.error;
  }
}
