import path from 'node:path';

import type { AgentUsage } from '@ello/agent';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { Box, Static, Text } from 'ink';
import type { ReactNode } from 'react';

import type { TranscriptItem, ToolCallView } from '../state/view-reducer.js';

import { Footer } from './Footer.js';
import { ToolCard } from './ToolCard.js';

export interface AppShellProps {
  readonly cwd: string;
  readonly model: string;
  readonly approvalMode: string;
  readonly transcript: readonly TranscriptItem[];
  readonly liveAssistantText: string;
  readonly runningTools: readonly ToolCallView[];
  readonly running: boolean;
  readonly usage?: AgentUsage;
  /** 浮层（审批/help/模型选择）。 */
  readonly overlay: ReactNode;
  /** 输入区（Composer）。 */
  readonly composer: ReactNode;
}

/**
 * 纵向工作台布局。
 *
 * 区域：Header / Transcript / Live run / Composer / Footer + Overlay。已结案的
 * transcript 用 ink 的 `<Static>` 一次性输出（只渲染一次、不参与重画），live 区
 * 才随事件重渲染——对应文档的“渲染预算”。
 */
export function AppShell(props: AppShellProps) {
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box justifyContent="space-between" paddingX={1}>
        <Text color="cyan">ello</Text>
        {props.running ? (
          <Spinner label="running" />
        ) : (
          <Text dimColor>ready</Text>
        )}
        <Text color="gray">{formatCwd(props.cwd)}</Text>
      </Box>

      <Static items={[...props.transcript]}>
        {(item) => <TranscriptLine key={item.id} item={item} />}
      </Static>

      {props.liveAssistantText !== '' ? (
        <Box marginTop={1}>
          <Text wrap="wrap">{props.liveAssistantText}</Text>
        </Box>
      ) : null}

      {props.runningTools.map((tool) => (
        <ToolCard key={tool.id} call={tool} />
      ))}

      {props.overlay}

      <Box marginTop={1}>{props.composer}</Box>

      <Footer
        model={props.model}
        approvalMode={props.approvalMode}
        {...(props.usage !== undefined ? { usage: props.usage } : {})}
      />
    </Box>
  );
}

/** 渲染一行 transcript：按 kind 分流。 */
function TranscriptLine({ item }: { readonly item: TranscriptItem }) {
  if (item.kind === 'tool') {
    return <ToolCard call={item.tool} compact />;
  }
  if (item.kind === 'diagnostic') {
    return (
      <Box marginBottom={1}>
        <StatusMessage variant="error">{item.text}</StatusMessage>
      </Box>
    );
  }
  const color = item.kind === 'user' ? 'green' : 'white';
  const label = item.kind === 'user' ? 'user' : 'assistant';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color}>{label}</Text>
      <Text wrap="wrap">{item.text}</Text>
    </Box>
  );
}

/** 把 cwd 压成 `parent/base` 形式，home 替换成 ~。 */
function formatCwd(cwd: string): string {
  const home = process.env.HOME;
  const display =
    home !== undefined && cwd.startsWith(home) ? cwd.replace(home, '~') : cwd;
  const base = path.basename(display);
  const parent = path.basename(path.dirname(display));
  return parent && parent !== '.' ? `${parent}/${base}` : display;
}
