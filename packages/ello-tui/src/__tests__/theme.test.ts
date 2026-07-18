import { describe, expect, it } from 'vitest';

import {
  defaultThemeName,
  listThemes,
  resolveTheme,
  themeNames,
} from '../tui/theme/index.js';
import type { TuiTheme } from '../tui/theme/index.js';

const REQUIRED_TOKENS: readonly (keyof TuiTheme)[] = [
  'text',
  'textMuted',
  'panel',
  'border',
  'borderActive',
  'selection',
  'accent',
  'success',
  'warning',
  'error',
  'info',
  'diffAdded',
  'diffRemoved',
  'diffContext',
  'diffAddedBackground',
  'diffRemovedBackground',
  'diffAddedGutter',
  'diffRemovedGutter',
  'markdownHeading',
  'markdownCode',
  'syntaxKeyword',
  'syntaxString',
];

describe('theme catalog', () => {
  it('ships at least two switchable themes', () => {
    expect(themeNames.length).toBeGreaterThanOrEqual(2);
    expect(themeNames).toContain(defaultThemeName);
  });

  it('every theme implements all semantic tokens', () => {
    for (const theme of listThemes()) {
      for (const token of REQUIRED_TOKENS) {
        expect(theme[token], `${theme.name}.${token}`).toBeTruthy();
      }
    }
  });

  it('throws on unknown theme rather than silently falling back', () => {
    expect(() => resolveTheme('does-not-exist' as never)).toThrow(
      /Unknown theme/u,
    );
  });

  it('resolves the default theme to a dark appearance tokyo-night', () => {
    const theme = resolveTheme(defaultThemeName);
    expect(theme.name).toBe('tokyo-night');
    expect(theme.appearance).toBe('dark');
  });
});
