export const tuiTokens = {
  color: {
    text: '#c0caf5',
    muted: '#565f89',
    accent: '#7dcfff',
    success: '#9ece6a',
    warning: '#e0af68',
    danger: '#f7768e',
    border: '#3b4261',
    borderActive: '#7aa2f7',
    panel: '#1f2335',
    selection: '#283457',
    markdownHeading: '#bb9af7',
    diffAdd: '#9ece6a',
    diffRemove: '#f7768e',
    diffContext: '#565f89',
  },
  space: {
    x: 1,
    section: 1,
    indent: 2,
  },
  width: {
    minMain: 48,
    minComposer: 20,
  },
} as const;

export type TuiColor = (typeof tuiTokens.color)[keyof typeof tuiTokens.color];
