import { Text } from 'ink';
import type { ReactNode } from 'react';

import { tuiTokens } from './tokens.js';

export function MutedText({ children }: { readonly children: ReactNode }) {
  return <Text color={tuiTokens.color.muted}>{children}</Text>;
}

export function TitleText({ children }: { readonly children: ReactNode }) {
  return <Text color={tuiTokens.color.accent}>{children}</Text>;
}

export function BodyText({ children }: { readonly children: ReactNode }) {
  return <Text color={tuiTokens.color.text}>{children}</Text>;
}

export function ErrorText({ children }: { readonly children: ReactNode }) {
  return <Text color={tuiTokens.color.danger}>{children}</Text>;
}
