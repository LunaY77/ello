import type { OverlayState } from '../overlays/OverlayHost.js';

/** TUI view state，只保存 focus/overlay/scroll 等视图状态。 */
export interface ViewState {
  readonly overlays: readonly OverlayState[];
  readonly focus: 'composer' | 'overlay';
  readonly expandedTools: readonly string[];
}

export type ViewAction =
  | { readonly type: 'overlay.push'; readonly overlay: OverlayState }
  | { readonly type: 'overlay.pop' }
  | { readonly type: 'overlay.clear' }
  | { readonly type: 'tool.toggle'; readonly toolCallId: string };

export const initialViewState: ViewState = {
  overlays: [],
  focus: 'composer',
  expandedTools: [],
};

/** overlay stack reducer。 */
export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  if (action.type === 'overlay.push') {
    return { ...state, overlays: [...state.overlays, action.overlay], focus: 'overlay' };
  }
  if (action.type === 'overlay.pop') {
    const overlays = state.overlays.slice(0, -1);
    return { ...state, overlays, focus: overlays.length === 0 ? 'composer' : 'overlay' };
  }
  if (action.type === 'overlay.clear') {
    return { ...state, overlays: [], focus: 'composer' };
  }
  const expanded = new Set(state.expandedTools);
  if (expanded.has(action.toolCallId)) expanded.delete(action.toolCallId);
  else expanded.add(action.toolCallId);
  return { ...state, expandedTools: [...expanded] };
}

export function topOverlay(state: ViewState): OverlayState {
  return state.overlays.at(-1) ?? { type: 'none' };
}
