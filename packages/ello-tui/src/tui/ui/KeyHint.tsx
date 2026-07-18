import { Text } from 'ink';

import { tuiTokens } from './tokens.js';

export function KeyHint({ keys }: { readonly keys: string }) {
  return <Text color={tuiTokens.color.muted}>{keys}</Text>;
}
