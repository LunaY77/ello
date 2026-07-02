import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from 'react';

import { defaultThemeName, resolveTheme } from './themes.js';
import type { TuiTheme } from './types.js';

const ThemeContext = createContext<TuiTheme>(resolveTheme(defaultThemeName));

export function ThemeProvider({
  theme,
  children,
}: {
  readonly theme: TuiTheme;
  readonly children: ReactNode;
}) {
  return createElement(ThemeContext.Provider, { value: theme }, children);
}

/** 组件读取当前主题 token。 */
export function useTheme(): TuiTheme {
  return useContext(ThemeContext);
}
