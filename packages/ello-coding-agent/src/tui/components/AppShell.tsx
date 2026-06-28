import path from 'node:path';

import { Box, Text } from 'ink';

import type { TranscriptItem } from '../../product/event-store.js';
import type { ToolCallView } from '../../product/events.js';
import type { FooterView } from '../state/selectors.js';

import { Composer } from './Composer.js';
import { Footer } from './Footer.js';
import { ToolCard } from './ToolCard.js';

export interface AppShellProps {
  readonly transcript: readonly TranscriptItem[];
  readonly currentAssistantText: string;
  readonly runningTools: readonly ToolCallView[];
  readonly footer: FooterView;
  readonly composerValue: string;
  readonly composerHints: readonly string[];
  readonly queueHint: string;
  readonly running: boolean;
  readonly composerActive?: boolean;
  readonly overlay: React.ReactNode;
  onComposerChange(value: string): void;
  onSubmit(value: string): void;
  onFollowUp?(value: string): void;
}

/** 纵向 coding-agent 工作台布局。 */
export function AppShell(props: AppShellProps) {
  const compactCwd = formatCwd(props.footer.cwd);
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box justifyContent="space-between" borderStyle="single" paddingX={1}>
        <Text color="cyan">ello</Text>
        <Text>{props.running ? 'run active' : 'ready'}</Text>
        <Text color="gray">{compactCwd}</Text>
      </Box>
      <Box flexDirection="column" borderStyle="single" paddingX={1} marginTop={1}>
        <Text color="gray">Transcript</Text>
        {props.transcript.length === 0 ? <Text dimColor>No transcript yet</Text> : props.transcript.map((item) => <TranscriptLine key={item.id} item={item} />)}
      </Box>
      <Box flexDirection="column" borderStyle="single" paddingX={1} marginTop={1}>
        <Box justifyContent="space-between">
          <Text color="cyan">Live run</Text>
          <Text color={props.running ? 'yellow' : 'green'}>{props.running ? 'streaming' : 'idle'}</Text>
        </Box>
        {props.currentAssistantText ? <Text wrap="wrap">{props.currentAssistantText}</Text> : <Text dimColor>{props.running ? 'waiting for model...' : 'no active response'}</Text>}
        {props.runningTools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Box justifyContent="space-between">
          <Text dimColor>{props.queueHint}</Text>
          <Text dimColor>{props.footer.context}</Text>
        </Box>
        {props.composerHints.length > 0 ? <Text dimColor>{props.composerHints.join('  ')}</Text> : null}
        <Composer
          value={props.composerValue}
          running={props.running}
          isActive={props.composerActive ?? true}
          onChange={props.onComposerChange}
          onSubmit={props.onSubmit}
          {...(props.onFollowUp !== undefined ? { onFollowUp: props.onFollowUp } : {})}
        />
      </Box>
      <Footer view={props.footer} />
      {props.overlay}
    </Box>
  );
}

function TranscriptLine({ item }: { readonly item: TranscriptItem }) {
  if (item.role === 'tool') {
    return <ToolCard tool={item.tool} compact />;
  }
  const color = item.role === 'user' ? 'green' : item.role === 'diagnostic' ? 'yellow' : 'white';
  const label = item.role === 'user' ? 'user' : item.role === 'assistant' ? 'assistant' : 'diagnostic';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color}>{label}</Text>
      <Text wrap="wrap">{item.text}</Text>
    </Box>
  );
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;
  const display = home !== undefined && cwd.startsWith(home) ? cwd.replace(home, '~') : cwd;
  const base = path.basename(display);
  const parent = path.basename(path.dirname(display));
  return parent && parent !== '.' ? `${parent}/${base}` : display;
}
