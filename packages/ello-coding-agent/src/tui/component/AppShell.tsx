import type { AgentUsage } from '@ello/agent';
import { Box } from 'ink';
import type { ReactNode } from 'react';

import type { GoalState } from '../../goal/types.js';
import type { SessionModeState } from '../../runtime/session-mode.js';
import type { SubagentRunView, ToolCallView } from '../store/history-entry.js';
import { tuiTokens } from '../ui/tokens.js';

import { BottomDock } from './BottomDock.js';
import { LiveViewport } from './LiveViewport.js';

export interface AppShellProps {
  readonly profile: string;
  readonly mode: SessionModeState;
  readonly pendingPlanApproval?: boolean;
  readonly liveAssistantText: string;
  readonly runningTools: readonly ToolCallView[];
  readonly runningSubagents: readonly SubagentRunView[];
  readonly running: boolean;
  readonly workingSeconds?: number;
  readonly interruptNotice?: string;
  readonly pendingSteers?: readonly string[];
  readonly usage?: AgentUsage;
  readonly goal?: GoalState;
  readonly overlay: ReactNode;
  readonly composer: ReactNode;
}

export function AppShell(props: AppShellProps) {
  const size = useTerminalSize();
  const mainWidth = Math.max(tuiTokens.width.minMain, size.columns);

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box flexDirection="column" width={mainWidth}>
        <LiveViewport
          assistantText={props.liveAssistantText}
          runningTools={props.runningTools}
          runningSubagents={props.runningSubagents}
          running={props.running}
          {...(props.workingSeconds !== undefined
            ? { workingSeconds: props.workingSeconds }
            : {})}
          {...(props.interruptNotice !== undefined
            ? { interruptNotice: props.interruptNotice }
            : {})}
          {...(props.pendingSteers !== undefined
            ? { pendingSteers: props.pendingSteers }
            : {})}
        />
      </Box>
      <BottomDock
        profile={props.profile}
        mode={props.mode}
        pendingPlanApproval={props.pendingPlanApproval === true}
        {...(props.usage !== undefined ? { usage: props.usage } : {})}
        {...(props.goal !== undefined ? { goal: props.goal } : {})}
        overlay={props.overlay}
        composer={props.composer}
      />
    </Box>
  );
}

function useTerminalSize(): {
  readonly columns: number;
} {
  return {
    columns: process.stdout.columns ?? 100,
  };
}
