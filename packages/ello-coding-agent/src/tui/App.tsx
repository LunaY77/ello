import { useApp, useInput } from 'ink';
import { useMemo, useState } from 'react';

import type { CodingAgentConfig } from '../config.js';
import type { CodingSession, ApprovalDecision } from '../runtime/index.js';
import { handleSlashCommand, type CommandResult } from '../slash-commands.js';

import { AppShell } from './components/AppShell.js';
import { Composer } from './components/Composer.js';
import { useRuntimeEvents } from './hooks/use-runtime-events.js';
import { OverlayHost, type OverlayState } from './overlays/OverlayHost.js';

export interface CodingAgentAppProps {
  readonly session: CodingSession;
  readonly config: CodingAgentConfig;
}

/**
 * TUI 根组件。
 *
 * 职责边界：渲染、采集输入、把意图回灌 {@link CodingSession}、管理浮层与焦点。
 * 不调用 `@ello/agent`、不判权限、不持久化、不执行工具。
 */
export function CodingAgentApp({ session, config }: CodingAgentAppProps) {
  const { exit } = useApp();
  const { state, pushUser } = useRuntimeEvents(session);
  const [overlay, setOverlay] = useState<OverlayState>({ type: 'none' });

  // 审批是最高优先级浮层：pendingApproval 一来就盖过其它浮层。
  const effectiveOverlay: OverlayState =
    state.pendingApproval !== undefined
      ? { type: 'approval', request: state.pendingApproval }
      : overlay;

  useInput((_input, key) => {
    if (key.escape) {
      if (effectiveOverlay.type !== 'none' && effectiveOverlay.type !== 'approval') {
        setOverlay({ type: 'none' });
      } else if (state.status === 'running') {
        session.abort();
      }
    }
  });

  /** 执行一条 slash command 的产品动作。 */
  const runCommand = (command: CommandResult): void => {
    switch (command.type) {
      case 'open-overlay':
        if (command.overlay === 'model-selector') {
          setOverlay({ type: 'model-selector', models: config.modelCandidates });
        } else if (command.overlay === 'help') {
          setOverlay({ type: 'help' });
        }
        return;
      case 'runtime-action':
        if (command.action === 'new-session') {
          void session.newSession();
        } else if (command.action === 'quit') {
          void session.close().then(() => exit());
        }
        return;
      case 'submit':
        pushUser(command.prompt);
        void session.submit(command.prompt);
        return;
      default:
        // message / set-model / set-permission-mode 等 v1 不在 TUI 内处理。
        return;
    }
  };

  /** 处理 Composer 的一次提交。 */
  const onSubmit = (value: string): void => {
    const prompt = value.trim();
    if (prompt === '') {
      return;
    }
    const slash = handleSlashCommand(prompt, config);
    if (slash.handled) {
      if (slash.command !== undefined) {
        runCommand(slash.command);
      }
      return;
    }
    if (state.status === 'running') {
      // 运行中提交 = steer（缓冲到下一轮）。
      session.steer(prompt);
      return;
    }
    pushUser(prompt);
    void session.submit(prompt);
  };

  const onApprove = (requestId: string, decision: ApprovalDecision): void => {
    void session.approve(requestId, decision);
  };

  const runningTools = useMemo(() => [...state.runningTools.values()], [state.runningTools]);

  return (
    <AppShell
      cwd={config.cwd}
      model={config.model}
      approvalMode={config.approvalMode}
      transcript={state.transcript}
      liveAssistantText={state.liveAssistantText}
      runningTools={runningTools}
      running={state.status === 'running'}
      {...(state.usage !== undefined ? { usage: state.usage } : {})}
      overlay={
        <OverlayHost
          overlay={effectiveOverlay}
          onApprove={onApprove}
          onSelectModel={() => setOverlay({ type: 'none' })}
        />
      }
      composer={
        <Composer
          running={state.status === 'running'}
          isActive={effectiveOverlay.type === 'none'}
          onSubmit={onSubmit}
        />
      }
    />
  );
}
