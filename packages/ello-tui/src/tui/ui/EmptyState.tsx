import { Text } from 'ink';

import { tuiTokens } from './tokens.js';

export function EmptyState({ label }: { readonly label: string }) {
  return <Text color={tuiTokens.color.muted}>{label}</Text>;
}
