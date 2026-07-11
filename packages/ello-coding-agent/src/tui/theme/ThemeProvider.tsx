import { createElement, type ReactNode } from 'react';

import { ThemeContext } from './context.js';
import type { TuiTheme } from './types.js';

export function ThemeProvider({
  theme,
  children,
}: {
  readonly theme: TuiTheme;
  readonly children: ReactNode;
}) {
  return createElement(ThemeContext.Provider, { value: theme }, children);
}
