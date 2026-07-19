import { createContext, useContext } from 'react';

import { defaultThemeName, resolveTheme } from './themes.js';
import type { TuiTheme } from './types.js';

export const ThemeContext = createContext<TuiTheme>(
  resolveTheme(defaultThemeName),
);

export function useTheme(): TuiTheme {
  return useContext(ThemeContext);
}
