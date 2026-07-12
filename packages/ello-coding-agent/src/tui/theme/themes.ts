import type { ThemeName, TuiTheme } from './types.js';

/** Tokyo Night Storm。 */
const tokyoNight: TuiTheme = {
  name: 'tokyo-night',
  appearance: 'dark',
  text: '#c0caf5',
  textMuted: '#565f89',
  panel: '#1f2335',
  border: '#3b4261',
  borderActive: '#7aa2f7',
  selection: '#283457',
  accent: '#7dcfff',
  success: '#9ece6a',
  warning: '#e0af68',
  error: '#f7768e',
  info: '#7aa2f7',
  diffAdded: '#9ece6a',
  diffRemoved: '#f7768e',
  diffContext: '#565f89',
  diffAddedBackground: '#213a2b',
  diffRemovedBackground: '#4a221d',
  diffAddedGutter: '#16351f',
  diffRemovedGutter: '#421b18',
  markdownHeading: '#bb9af7',
  markdownCode: '#7dcfff',
  syntaxKeyword: '#bb9af7',
  syntaxString: '#9ece6a',
};

/** GitHub Dark。 */
const githubDark: TuiTheme = {
  name: 'github-dark',
  appearance: 'dark',
  text: '#e6edf3',
  textMuted: '#7d8590',
  panel: '#161b22',
  border: '#30363d',
  borderActive: '#58a6ff',
  selection: '#1f6feb44',
  accent: '#58a6ff',
  success: '#3fb950',
  warning: '#d29922',
  error: '#f85149',
  info: '#58a6ff',
  diffAdded: '#3fb950',
  diffRemoved: '#f85149',
  diffContext: '#7d8590',
  diffAddedBackground: '#213a2b',
  diffRemovedBackground: '#4a221d',
  diffAddedGutter: '#16351f',
  diffRemovedGutter: '#421b18',
  markdownHeading: '#d2a8ff',
  markdownCode: '#79c0ff',
  syntaxKeyword: '#ff7b72',
  syntaxString: '#a5d6ff',
};

/** GitHub Light。 */
const githubLight: TuiTheme = {
  name: 'github-light',
  appearance: 'light',
  text: '#1f2328',
  textMuted: '#656d76',
  background: '#ffffff',
  panel: '#f6f8fa',
  border: '#d0d7de',
  borderActive: '#0969da',
  selection: '#ddf4ff',
  accent: '#0969da',
  success: '#1a7f37',
  warning: '#9a6700',
  error: '#cf222e',
  info: '#0969da',
  diffAdded: '#1a7f37',
  diffRemoved: '#cf222e',
  diffContext: '#656d76',
  diffAddedBackground: '#dafbe1',
  diffRemovedBackground: '#ffebe9',
  diffAddedGutter: '#aceebb',
  diffRemovedGutter: '#ffcecb',
  markdownHeading: '#8250df',
  markdownCode: '#0550ae',
  syntaxKeyword: '#cf222e',
  syntaxString: '#0a3069',
};

/** Catppuccin Mocha。 */
const catppuccin: TuiTheme = {
  name: 'catppuccin',
  appearance: 'dark',
  text: '#cdd6f4',
  textMuted: '#7f849c',
  panel: '#181825',
  border: '#313244',
  borderActive: '#89b4fa',
  selection: '#313244',
  accent: '#89dceb',
  success: '#a6e3a1',
  warning: '#f9e2af',
  error: '#f38ba8',
  info: '#89b4fa',
  diffAdded: '#a6e3a1',
  diffRemoved: '#f38ba8',
  diffContext: '#7f849c',
  diffAddedBackground: '#213a2b',
  diffRemovedBackground: '#4a221d',
  diffAddedGutter: '#16351f',
  diffRemovedGutter: '#421b18',
  markdownHeading: '#cba6f7',
  markdownCode: '#89dceb',
  syntaxKeyword: '#cba6f7',
  syntaxString: '#a6e3a1',
};

const THEMES: Record<ThemeName, TuiTheme> = {
  'tokyo-night': tokyoNight,
  'github-dark': githubDark,
  'github-light': githubLight,
  catppuccin,
};

export const themeNames: readonly ThemeName[] = [
  'tokyo-night',
  'github-dark',
  'github-light',
  'catppuccin',
];

export const defaultThemeName: ThemeName = 'tokyo-night';

/** 取主题；未知名直接抛错（不静默回退），符合 breaking 原则。 */
export function resolveTheme(name: ThemeName): TuiTheme {
  const theme = THEMES[name];
  if (theme === undefined) {
    throw new Error(`Unknown theme: ${name}`);
  }
  return theme;
}

/** 列出可切换主题，供 command palette / dialog 渲染。 */
export function listThemes(): readonly TuiTheme[] {
  return themeNames.map(resolveTheme);
}
