/** composer 独立状态。 */
export interface ComposerState {
  readonly value: string;
  readonly history: readonly string[];
  readonly historyIndex: number | null;
  readonly suggestions: readonly string[];
}

export type ComposerAction =
  | { readonly type: 'insert'; readonly text: string }
  | { readonly type: 'newline' }
  | { readonly type: 'backspace' }
  | { readonly type: 'clear' }
  | { readonly type: 'submitted'; readonly value: string }
  | { readonly type: 'history.prev' }
  | { readonly type: 'history.next' }
  | { readonly type: 'suggestions.set'; readonly suggestions: readonly string[] };

export const initialComposerState: ComposerState = {
  value: '',
  history: [],
  historyIndex: null,
  suggestions: [],
};

/** 多行 composer reducer，和 React/Ink 输入事件解耦，便于测试 paste/history。 */
export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  if (action.type === 'insert') {
    return { ...state, value: `${state.value}${action.text}`, historyIndex: null };
  }
  if (action.type === 'newline') {
    return { ...state, value: `${state.value}\n` };
  }
  if (action.type === 'backspace') {
    return { ...state, value: state.value.slice(0, -1) };
  }
  if (action.type === 'clear') {
    return { ...state, value: '', historyIndex: null };
  }
  if (action.type === 'submitted') {
    const trimmed = action.value.trim();
    return {
      ...state,
      value: '',
      history: trimmed ? [trimmed, ...state.history.filter((item) => item !== trimmed)].slice(0, 100) : state.history,
      historyIndex: null,
    };
  }
  if (action.type === 'history.prev') {
    if (state.history.length === 0) return state;
    const nextIndex = state.historyIndex === null ? 0 : Math.min(state.historyIndex + 1, state.history.length - 1);
    return { ...state, historyIndex: nextIndex, value: state.history[nextIndex] ?? state.value };
  }
  if (action.type === 'history.next') {
    if (state.historyIndex === null) return state;
    const nextIndex = state.historyIndex - 1;
    return nextIndex < 0
      ? { ...state, historyIndex: null, value: '' }
      : { ...state, historyIndex: nextIndex, value: state.history[nextIndex] ?? '' };
  }
  return { ...state, suggestions: action.suggestions };
}

/** 根据当前输入生成轻量 suggestions。 */
export function suggestComposer(value: string, commands: readonly string[]): string[] {
  const token = value.split(/\s+/).at(-1) ?? '';
  if (token.startsWith('/')) {
    return commands.filter((command) => command.startsWith(token.slice(1))).map((command) => `/${command}`);
  }
  if (token.startsWith('@')) {
    return ['@package.json', '@src/', '@docs/'].filter((item) => item.startsWith(token));
  }
  if (token.startsWith('!')) {
    return ['!pnpm test', '!pnpm lint', '!git status'].filter((item) => item.startsWith(token));
  }
  return [];
}
