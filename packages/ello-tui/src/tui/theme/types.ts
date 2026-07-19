/** 内置主题名。用户主题加载（~/.ello/themes/*.toml）留待后续版本。 */
export type ThemeName =
  | 'tokyo-night'
  | 'github-dark'
  | 'github-light'
  | 'catppuccin';

export type ThemeAppearance = 'dark' | 'light';

/**
 * TUI 主题 token。
 *
 * 所有组件（transcript / diff / tool / status / dialog）只能引用这些语义 token，
 * 不再直接写死 `tokyoNight.red` 这类调色板色值。新增主题 = 实现这一组 token。
 */
export interface TuiTheme {
  readonly name: ThemeName;
  readonly appearance: ThemeAppearance;

  /** 正文。 */
  readonly text: string;
  /** 次要/说明文本。 */
  readonly textMuted: string;
  /** 终端默认背景（多数终端透明，故可选）。 */
  readonly background?: string;
  /** 面板/卡片背景与边框。 */
  readonly panel: string;
  readonly border: string;
  readonly borderActive: string;
  /** 选中行高亮背景。 */
  readonly selection: string;

  /** 强调色（标题、提示符、焦点）。 */
  readonly accent: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly info: string;

  /** diff 三态。 */
  readonly diffAdded: string;
  readonly diffRemoved: string;
  readonly diffContext: string;
  readonly diffAddedBackground: string;
  readonly diffRemovedBackground: string;
  readonly diffAddedGutter: string;
  readonly diffRemovedGutter: string;

  /** markdown / 语法上色（v1 仅粗粒度）。 */
  readonly markdownHeading: string;
  readonly markdownCode: string;
  readonly syntaxKeyword: string;
  readonly syntaxString: string;
}
