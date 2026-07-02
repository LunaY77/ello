import { Text } from 'ink';

import { tuiTokens } from './tokens.js';

export function StatusBadge({
  label,
  tone,
}: {
  readonly label: string;
  readonly tone: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  return <Text color={toneColor(tone)}>{label}</Text>;
}

export const ModelBadge = StatusBadge;
export const PermissionBadge = StatusBadge;

function toneColor(tone: 'neutral' | 'success' | 'warning' | 'danger'): string {
  switch (tone) {
    case 'neutral':
      return tuiTokens.color.muted;
    case 'success':
      return tuiTokens.color.success;
    case 'warning':
      return tuiTokens.color.warning;
    case 'danger':
      return tuiTokens.color.danger;
  }
}
