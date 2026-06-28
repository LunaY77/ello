import { defaultTheme, extendTheme, type Theme } from '@inkjs/ui';

/**
 * ello TUI 主题。
 *
 * `@inkjs/ui` 把样式集中在 theme，通过 `ThemeProvider` + `extendTheme` 注入，
 * 组件里不再散落 `color="cyan"` 这类硬编码。这里只覆盖少量需要品牌化的组件，
 * 其余沿用 `defaultTheme`。
 */
export const elloTheme: Theme = extendTheme(defaultTheme, {
  components: {
    Spinner: {
      styles: {
        frame: () => ({ color: 'cyan' }),
      },
    },
  },
});
