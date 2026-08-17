import { Box } from 'ink';
import type { ReactNode } from 'react';

import type { Goal, Usage } from '../../api/protocol-types.js';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import type {
  CommandRunView,
  SubagentRunView,
  ToolCallView,
} from '../store/history-entry.js';
import { liveViewportRows } from '../store/live-budget.js';

import { BottomDock, type TuiModeState } from './BottomDock.js';
import { LiveViewport } from './LiveViewport.js';

export interface AppShellProps {
  readonly cwd: string;
  readonly model: string;
  readonly mode: TuiModeState;
  readonly pendingPlanApproval?: boolean;
  readonly liveAssistantText: string;
  readonly liveReasoningText?: string;
  readonly liveCompactionText?: string;
  readonly runningTools: readonly ToolCallView[];
  readonly runningCommandRuns?: readonly CommandRunView[];
  readonly runningSubagents: readonly SubagentRunView[];
  readonly running: boolean;
  readonly workingSeconds?: number;
  readonly interruptNotice?: string;
  readonly pendingSteers?: readonly string[];
  readonly usage?: Usage;
  readonly goal?: Goal;
  readonly contextPercent?: number;
  readonly contextWindow?: number;
  readonly overlay: ReactNode;
  readonly composer: ReactNode;
  readonly agentSwitcher?: ReactNode;
  readonly agentTranscript?: (viewport: {
    readonly maxRows: number;
    readonly textWidth: number;
  }) => ReactNode;
  /** Composer 文本占用的视觉行数，用于扣减 live 区预算。 */
  readonly composerRows?: number;
  /** Agent switcher 行数；0 表示不渲染。 */
  readonly agentRows?: number;
  /** dock 顶部是否挂着 overlay。 */
  readonly overlayOpen?: boolean;
}

/**
 * 主屏只渲染 dynamic viewport 与 bottom dock，历史留在 shell scrollback。
 *
 * 这里刻意不给根 Box 设 `height`：Ink 对超出固定高度的 column 内容不是裁剪，而是把
 * 子节点压扁成非连续的行，会把 composer 边框和 footer 撕碎。高度约束只能落在 live
 * 区的内容上，见 `store/live-budget.ts`。
 */
export function AppShell(props: AppShellProps) {
  const size = useTerminalSize();
  const mainWidth = Math.max(1, size.columns - 2);
  const liveRows = liveViewportRows(size.rows, {
    composerRows: props.composerRows ?? 1,
    agentRows: props.agentRows ?? 0,
    overlayOpen: props.overlayOpen ?? false,
  });

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box flexDirection="column" flexShrink={0} width={mainWidth}>
        {props.agentTranscript?.({
          maxRows: liveRows,
          textWidth: mainWidth,
        }) ?? (
          <LiveViewport
            cwd={props.cwd}
            assistantText={props.liveAssistantText}
            reasoningText={props.liveReasoningText ?? ''}
            compactionText={props.liveCompactionText ?? ''}
            runningTools={props.runningTools}
            runningCommandRuns={props.runningCommandRuns ?? []}
            runningSubagents={props.runningSubagents}
            running={props.running}
            maxRows={liveRows}
            textWidth={mainWidth}
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
        )}
      </Box>
      <BottomDock
        model={props.model}
        mode={props.mode}
        pendingPlanApproval={props.pendingPlanApproval === true}
        {...(props.usage !== undefined ? { usage: props.usage } : {})}
        {...(props.goal !== undefined ? { goal: props.goal } : {})}
        {...(props.contextPercent !== undefined
          ? { contextPercent: props.contextPercent }
          : {})}
        {...(props.contextWindow !== undefined
          ? { contextWindow: props.contextWindow }
          : {})}
        overlay={props.overlay}
        composer={props.composer}
        {...(props.agentSwitcher === undefined
          ? {}
          : { agentSwitcher: props.agentSwitcher })}
      />
    </Box>
  );
}
