import { Text } from 'ink';

import { useTheme } from '../theme/index.js';

export function KeyHint({ keys }: { readonly keys: string }) {
  const theme = useTheme();
  return <Text color={theme.textMuted}>{keys}</Text>;
}
