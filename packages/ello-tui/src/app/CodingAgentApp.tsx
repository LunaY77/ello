import type { CodingAgentConfig, CodingAgentController } from '@ello/coding-agent';
import { useApp } from 'ink';
import React, { useEffect, useMemo, useReducer, useState } from 'react';


import {
  AppShell,
  CommandPalette,
  Overlay,
  StatusBar,
  ToolApprovalPanel,
  ToolCards,
  Transcript,
} from '../Components.js';
import { Composer } from '../Composer.js';
import { suggestFileReferences, type FileSuggestion } from '../file-autocomplete.js';
import { suggestSlashCommands } from '../helpers.js';
import { useCodingAgentKeybindings } from '../input.js';
import {
  createInitialState,
  tuiReducer,
} from '../state/index.js';

import { createApprovalActions } from './approval-actions.js';
import { useSessionEvents } from './session-events.js';
import { createSubmitHandler } from './use-submit.js';

export interface CodingAgentAppProps {
  /** 连接 TUI 与 coding-agent package 的会话 controller。 */
  controller: CodingAgentController;
  /** 用于初始状态、prompt 和状态面板的产品层解析后配置。 */
  config: CodingAgentConfig;
}

/**
 * coding-agent 产品的 Ink app。
 *
 * 该组件协调状态、命令执行和渲染。领域行为保留在 `@ello/coding-agent`；
 * 键盘路由、提交处理和审批动作拆分到 app 层 helper 中。
 */
export function CodingAgentApp(props: CodingAgentAppProps) {
  const app = useApp();
  const [state, dispatch] = useReducer(tuiReducer, createInitialState(props.config));
  const [fileSuggestions, setFileSuggestions] = useState<FileSuggestion[]>([]);
  const slashSuggestions = state.composer.startsWith('/')
    ? suggestSlashCommands(state.composer)
    : [];
  const submit = useMemo(
    () =>
      createSubmitHandler({
        config: props.config,
        controller: props.controller,
        dispatch,
        exit: app.exit,
      }),
    [app.exit, props.config, props.controller],
  );
  const approvalActions = createApprovalActions({
    controller: props.controller,
    state,
  });

  useEffect(() => {
    if (state.historyIndex === null) {
      return;
    }
    dispatch({ type: 'composer_set', value: state.history[state.historyIndex] ?? '' });
  }, [state.history, state.historyIndex]);

  useSessionEvents(props.controller, dispatch);

  useEffect(() => {
    let cancelled = false;
    void suggestFileReferences(state.composer, props.config.cwd).then((suggestions) => {
      if (!cancelled) {
        setFileSuggestions(suggestions);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [props.config.cwd, state.composer]);

  useCodingAgentKeybindings({
    controller: props.controller,
    state,
    input: state.composer,
    setInput: (value) => dispatch({ type: 'composer_set', value }),
    fileSuggestions,
    onResumeSelectedSession: async () => {
      const selected = state.sessions[state.sessionIndex];
      if (!selected) {
        return;
      }
      await props.controller.resumeSession(selected.sessionId);
      dispatch({ type: 'overlay', overlay: null });
    },
    slashSuggestions,
    dispatch,
    exit: app.exit,
  });

  function handleApprovalDraftChange(value: string): void {
    dispatch({ type: 'approval_draft', value });
  }

  return (
    <AppShell>
      <Transcript items={state.transcript} />
      <ToolCards cards={Object.values(state.tools)} />
      <ToolApprovalPanel
        request={state.pendingApproval}
        draft={state.approvalDraft}
        onDraftChange={handleApprovalDraftChange}
        onApprove={approvalActions.approve}
        onReject={approvalActions.reject}
        onEdit={approvalActions.edit}
        editing={state.approvalEditing}
      />
      <Overlay state={state} />
      <StatusBar state={state} config={props.config} />
      {slashSuggestions.length > 0 ? <CommandPalette suggestions={slashSuggestions} /> : null}
      {slashSuggestions.length === 0 && fileSuggestions.length > 0 ? (
        <CommandPalette
          title="files"
          suggestions={fileSuggestions.map((suggestion) => suggestion.label)}
        />
      ) : null}
      <Composer
        value={state.composer}
        mode={state.historyIndex === null ? 'normal' : 'history'}
        onChange={(value) => dispatch({ type: 'composer_set', value })}
        onSubmit={submit}
        focus={state.pendingApproval === null || state.approvalEditing}
      />
    </AppShell>
  );
}
