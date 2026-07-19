import { Text } from 'ink';

import { useTheme } from '../theme/index.js';

export function EmptyState({ label }: { readonly label: string }) {
  const theme = useTheme();
  return <Text color={theme.textMuted}>{label}</Text>;
}
