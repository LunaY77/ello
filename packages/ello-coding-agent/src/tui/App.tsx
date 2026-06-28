import { useInput } from 'ink';
import { useMemo, useReducer } from 'react';

import type { CodingAgentConfig } from '../config.js';
import { CodingAgentRuntime } from '../product/runtime.js';
import { handleSlashCommand, type CommandResult } from '../slash-commands.js';

import { AppShell } from './components/AppShell.js';
import { useComposerController } from './hooks/use-composer-controller.js';
import { useRuntimeEvents } from './hooks/use-runtime-events.js';
import { OverlayHost, type OverlayState } from './overlays/OverlayHost.js';
import { selectApprovalDialog, selectFooter, selectRunningTools } from './state/selectors.js';
import { initialViewState, topOverlay, viewReducer } from './state/view-reducer.js';

export interface CodingAgentAppProps {
  readonly runtime: CodingAgentRuntime;
  readonly config: CodingAgentConfig;
}

/** React Ink 应用根组件。 */
export function CodingAgentApp({ runtime, config }: CodingAgentAppProps) {
  const snapshot = useRuntimeEvents(runtime);
  const composer = useComposerController();
  const [view, dispatchView] = useReducer(viewReducer, initialViewState);
  const approval = selectApprovalDialog(snapshot);
  const overlay = topOverlay(view);
  const effectiveOverlay: OverlayState = overlay.type === 'none' && approval !== null
    ? { type: 'approval', request: approval }
    : overlay;

  useInput((input, key) => {
    if (effectiveOverlay.type === 'approval') {
      if (input === 'a') void runtime.approve(effectiveOverlay.request.id, { action: 'approve_once' }).then(() => dispatchView({ type: 'overlay.clear' }));
      if (input === 'A') void runtime.approve(effectiveOverlay.request.id, { action: 'always_allow', scope: 'session' }).then(() => dispatchView({ type: 'overlay.clear' }));
      if (input === 'd') void runtime.approve(effectiveOverlay.request.id, { action: 'deny' }).then(() => dispatchView({ type: 'overlay.clear' }));
      return;
    }
    if (key.escape) {
      if (effectiveOverlay.type !== 'none') dispatchView({ type: 'overlay.pop' });
      else runtime.abort();
    }
  });

  const footer = useMemo(() => selectFooter({ cwd: config.cwd, model: config.model, mode: config.approvalMode, snapshot }), [config, snapshot]);
  const runningTools = useMemo(() => selectRunningTools(snapshot), [snapshot]);
  const runCommand = (command: CommandResult) => {
    if (command.type === 'open-overlay') {
      dispatchView({
        type: 'overlay.push',
        overlay: command.overlay === 'model-selector'
          ? { type: 'model-selector', models: config.modelCandidates }
          : { type: command.overlay },
      });
      return;
    }
    if (command.type === 'set-model') {
      void runtime.switchModel(command.model);
      return;
    }
    if (command.type === 'runtime-action') {
      if (command.action === 'compact') void runtime.compact();
      else if (command.action === 'new-session') void runtime.newSession();
      else if (command.action === 'fork') void runtime.fork(command.args?.[0] ?? '', { reason: command.args?.slice(1).join(' ') || 'tui' });
      else if (command.action === 'export') void runtime.exportSession(command.args?.[0] === 'html' ? 'html' : 'jsonl');
      else if (command.action === 'quit') void runtime.close();
      return;
    }
    if (command.type === 'submit') {
      void runtime.submit({ prompt: command.prompt, source: 'command' });
    }
  };

  return (
    <AppShell
      transcript={snapshot.transcript}
      currentAssistantText={snapshot.currentAssistantText}
      runningTools={runningTools}
      footer={footer}
      composerValue={composer.state.value}
      composerHints={composer.state.suggestions}
      queueHint={snapshot.running ? 'steering: Enter queues next instruction  follow-up: Alt+Enter after completion' : 'ready'}
      running={snapshot.running}
      composerActive={effectiveOverlay.type === 'none'}
      overlay={<OverlayHost overlay={effectiveOverlay} />}
      onComposerChange={(value) => {
        composer.clear();
        composer.insert(value);
      }}
      onSubmit={(value) => {
        const prompt = value.trim();
        if (!prompt) return;
        composer.submitted(value);
        const slash = handleSlashCommand(prompt, config);
        if (slash.handled) {
          if (slash.command !== undefined) runCommand(slash.command);
          return;
        }
        if (snapshot.running) runtime.steer({ prompt, source: 'steer' });
        else void runtime.submit(prompt);
      }}
      onFollowUp={(value) => {
        const prompt = value.trim();
        if (!prompt) return;
        composer.submitted(value);
        runtime.followUp({ prompt, source: 'follow-up' });
      }}
    />
  );
}
