import { Text } from 'ink';
import type { ReactNode } from 'react';

import { tuiTokens } from './tokens.js';

export function HistoryLine({
  tone = 'text',
  children,
}: {
  readonly tone?: keyof typeof tuiTokens.color;
  readonly children: ReactNode;
}) {
  return <Text color={tuiTokens.color[tone]}>{children}</Text>;
}
