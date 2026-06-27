import type { CodingAgentController } from '@ello/coding-agent';
import type { Dispatch } from 'react';

import { applyFileSuggestion, type FileSuggestion } from './file-autocomplete.js';
import { errorItem, systemItem, type TuiAction, type TuiState } from './state/index.js';

export interface KeyLike {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  escape?: boolean;
  return?: boolean;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
}

export interface KeybindingOptions {
  controller: CodingAgentController;
  state: TuiState;
  input: string;
  setInput: (value: string) => void;
  slashSuggestions: string[];
  fileSuggestions: FileSuggestion[];
  onResumeSelectedSession: () => void | Promise<void>;
  dispatch: Dispatch<TuiAction>;
  exit: () => void;
}

/**
 * 处理一次按键事件；事件被消费时返回 true。
 */
export function handleCodingAgentKey(
  options: KeybindingOptions,
  value: string,
  key: KeyLike,
): boolean {
  if (
    key.return &&
    (key.shift || key.meta) &&
    options.state.overlay === null &&
    options.state.pendingApproval === null
  ) {
    options.setInput(`${options.input}\n`);
    return true;
  }
  if (key.ctrl && value === 'c') {
    if (options.state.status === 'running') {
      options.controller.interrupt();
      options.dispatch({ type: 'append', item: systemItem('Interrupted current run.') });
      return true;
    }
    if (!options.state.exitPending) {
      options.dispatch({ type: 'exit_pending', value: true });
      options.dispatch({ type: 'append', item: systemItem('Press Ctrl+C again to exit.') });
      return true;
    }
    options.exit();
    return true;
  }
  if (key.ctrl && value === 'l') {
    options.dispatch({ type: 'exit_pending', value: false });
    options.dispatch({ type: 'overlay', overlay: options.state.overlay === 'model' ? null : 'model' });
    return true;
  }
  if (key.ctrl && value === 'r') {
    void options.controller.resumeInterruptedRun().catch((error: unknown) => {
      options.dispatch({
        type: 'append',
        item: errorItem(error instanceof Error ? error.message : String(error)),
      });
    });
    return true;
  }
  if (key.escape) {
    options.dispatch({ type: 'exit_pending', value: false });
    options.dispatch({ type: 'overlay', overlay: null });
    return true;
  }
  if (options.state.pendingApproval && value === 'e') {
    options.dispatch({ type: 'approval_editing', value: true });
    return true;
  }
  if (options.state.pendingApproval && value === 'a' && options.state.approvalEditing) {
    void options.controller.approveToolCall(
      options.state.pendingApproval.toolCallId,
      'approve',
    );
    options.dispatch({ type: 'approval_cleared' });
    return true;
  }
  if (options.state.pendingApproval && value === 'a') {
    options.dispatch({ type: 'approval_editing', value: false });
    return true;
  }
  if (options.state.pendingApproval && value === 'd') {
    void options.controller.rejectToolCall(options.state.pendingApproval.toolCallId);
    options.dispatch({ type: 'approval_cleared' });
    return true;
  }
  if (options.state.overlay === 'sessions' && key.upArrow) {
    options.dispatch({ type: 'session_prev' });
    return true;
  }
  if (options.state.overlay === 'sessions' && key.downArrow) {
    options.dispatch({ type: 'session_next' });
    return true;
  }
  if (options.state.overlay === 'sessions' && key.return) {
    void options.onResumeSelectedSession();
    return true;
  }
  if (options.state.overlay === 'model' && key.upArrow) {
    options.dispatch({ type: 'model_prev' });
    return true;
  }
  if (options.state.overlay === 'model' && key.downArrow) {
    options.dispatch({ type: 'model_next' });
    return true;
  }
  if (options.state.overlay === 'model' && key.return) {
    void options.controller.switchModelByIndex(options.state.modelIndex).then(() => {
      options.dispatch({ type: 'overlay', overlay: null });
    });
    return true;
  }
  if (key.upArrow) {
    options.dispatch({ type: 'exit_pending', value: false });
    options.dispatch({ type: 'history_prev' });
    return true;
  }
  if (key.downArrow) {
    options.dispatch({ type: 'exit_pending', value: false });
    options.dispatch({ type: 'history_next' });
    return true;
  }
  if (key.tab && options.fileSuggestions.length > 0) {
    const suggestion = options.fileSuggestions[0];
    if (suggestion !== undefined) {
      options.setInput(applyFileSuggestion(options.input, suggestion));
    }
    return true;
  }
  if (key.tab && options.slashSuggestions.length > 0) {
    options.setInput(options.slashSuggestions[0] ?? options.input);
    return true;
  }
  return false;
}
