import { Text } from 'ink';
import type { ReactNode } from 'react';

import { useTheme } from '../theme/index.js';

export function MutedText({ children }: { readonly children: ReactNode }) {
  const theme = useTheme();
  return <Text color={theme.textMuted}>{children}</Text>;
}

export function TitleText({ children }: { readonly children: ReactNode }) {
  const theme = useTheme();
  return <Text color={theme.accent}>{children}</Text>;
}

export function BodyText({ children }: { readonly children: ReactNode }) {
  const theme = useTheme();
  return <Text color={theme.text}>{children}</Text>;
}

export function ErrorText({ children }: { readonly children: ReactNode }) {
  const theme = useTheme();
  return <Text color={theme.error}>{children}</Text>;
}
