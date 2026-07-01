import type { AgentUsage } from '@ello/agent';
import { Box, Static, Text } from 'ink';
import type { ReactNode } from 'react';

import type {
  SubagentRunView,
  TranscriptItem,
  ToolCallView,
} from '../state/view-reducer.js';
import { tokyoNight } from '../tokyo-night.js';

import { Footer } from './Footer.js';
import { ToolCard } from './ToolCard.js';

const SUBAGENT_VISIBLE_TOOL_LIMIT = 4;

export interface AppShellProps {
  readonly cwd: string;
  readonly profile: string;
  readonly approvalMode: string;
  readonly transcript: readonly TranscriptItem[];
  readonly liveAssistantText: string;
  readonly runningTools: readonly ToolCallView[];
  readonly runningSubagents: readonly SubagentRunView[];
  readonly running: boolean;
  readonly workingSeconds?: number;
  readonly workedFor?: string;
  readonly interruptNotice?: string;
  readonly pendingSteers?: readonly string[];
  readonly usage?: AgentUsage;
  readonly version?: string;
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
  const hasTranscript =
    props.transcript.length > 0 ||
    props.liveAssistantText !== '' ||
    props.runningTools.length > 0 ||
    props.runningSubagents.length > 0;
  const hero = {
    id: 'hero',
    cwd: props.cwd,
    profile: props.profile,
    approvalMode: props.approvalMode,
    running: props.running,
    version: props.version,
  };

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Static items={[hero]}>
        {(item) => (
          <HeroPanel
            key={item.id}
            cwd={item.cwd}
            profile={item.profile}
            approvalMode={item.approvalMode}
            running={item.running}
            {...(item.version !== undefined ? { version: item.version } : {})}
          />
        )}
      </Static>

      {hasTranscript ? (
        <Box marginTop={1} flexDirection="column">
          {props.transcript.map((item) => (
            <TranscriptLine key={item.id} item={item} />
          ))}

          {props.liveAssistantText !== '' ? (
            <Box marginTop={1}>
              <Text color={tokyoNight.foreground} wrap="wrap">
                {props.liveAssistantText}
              </Text>
            </Box>
          ) : null}

          {props.runningTools.map((tool) => (
            <ToolCard key={tool.id} call={tool} />
          ))}

          {props.runningSubagents.map((run) => (
            <SubagentCard key={run.runId} run={run} />
          ))}
        </Box>
      ) : null}

      {props.pendingSteers !== undefined && props.pendingSteers.length > 0 ? (
        <PendingSteers prompts={props.pendingSteers} />
      ) : null}

      {props.running ? (
        <Box marginTop={1} paddingX={1}>
          <Text color={tokyoNight.yellow}>
            {`working... ${props.workingSeconds ?? 0}s`}
          </Text>
        </Box>
      ) : props.interruptNotice !== undefined ? (
        <Box marginTop={1} paddingX={1}>
          <Text color={tokyoNight.red}>{props.interruptNotice}</Text>
        </Box>
      ) : props.workedFor !== undefined ? (
        <Box marginTop={1} paddingX={1}>
          <Text
            color={tokyoNight.muted}
          >{`worked for ${props.workedFor}`}</Text>
        </Box>
      ) : null}

      {props.overlay}

      <Box marginTop={1}>{props.composer}</Box>

      <Box>
        <Footer
          profile={props.profile}
          approvalMode={props.approvalMode}
          {...(props.usage !== undefined ? { usage: props.usage } : {})}
        />
      </Box>
    </Box>
  );
}

function PendingSteers({ prompts }: { readonly prompts: readonly string[] }) {
  return (
    <Box marginTop={1} flexDirection="column" paddingX={1}>
      <Text color={tokyoNight.yellow}>
        Messages to be submitted after next tool call
      </Text>
      <Text color={tokyoNight.muted}>
        (press esc to interrupt and send immediately)
      </Text>
      {prompts.map((prompt, index) => (
        <Text key={`${index}:${prompt}`} color={tokyoNight.foreground}>
          {`↳ ${prompt}`}
        </Text>
      ))}
    </Box>
  );
}

function HeroPanel(props: {
  readonly cwd: string;
  readonly profile: string;
  readonly approvalMode: string;
  readonly running: boolean;
  readonly version?: string;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={props.running ? tokyoNight.yellow : tokyoNight.blue}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text
          color={tokyoNight.cyan}
        >{`>_ Ello Coding Agent${props.version ? ` (v${props.version})` : ''}`}</Text>
        <Text color={props.running ? tokyoNight.yellow : tokyoNight.green}>
          {props.running ? 'running' : 'ready'}
        </Text>
      </Box>
      <Text>
        <Text color={tokyoNight.muted}>profile: </Text>
        <Text color={tokyoNight.foreground}>{props.profile}</Text>
        <Text color={tokyoNight.muted}> /profiles to change</Text>
      </Text>
      <Text>
        <Text color={tokyoNight.muted}>directory: </Text>
        <Text color={tokyoNight.foreground}>{compactPath(props.cwd)}</Text>
      </Text>
      <Text>
        <Text color={tokyoNight.muted}>permissions: </Text>
        <Text color={tokyoNight.foreground}>
          {formatPermission(props.approvalMode)}
        </Text>
      </Text>
    </Box>
  );
}

/** 渲染一行 transcript：按 kind 分流。 */
function TranscriptLine({ item }: { readonly item: TranscriptItem }) {
  if (item.kind === 'tool') {
    return (
      <Box marginBottom={1} marginLeft={4} flexDirection="column">
        <ToolCard call={item.tool} compact={!hasDiffOutput(item.tool)} />
      </Box>
    );
  }
  if (item.kind === 'diagnostic') {
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text color={tokyoNight.red}>× error</Text>
        <Text color={tokyoNight.red} wrap="wrap">
          {item.text}
        </Text>
      </Box>
    );
  }
  if (item.kind === 'subagent') {
    return (
      <Box marginBottom={1} flexDirection="column">
        <SubagentCard run={item.run} />
      </Box>
    );
  }
  if (item.kind === 'system') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={tokyoNight.cyan}>• ello</Text>
        <Text color={tokyoNight.foreground} wrap="wrap">
          {item.text}
        </Text>
      </Box>
    );
  }
  const color = item.kind === 'user' ? tokyoNight.green : tokyoNight.foreground;
  return (
    <Box marginBottom={1} flexDirection="column">
      {item.kind === 'user' && item.entryId !== undefined ? (
        <Box gap={1}>
          <Text color={tokyoNight.muted}>user</Text>
          <Text color={tokyoNight.cyan}>{shortEntryId(item.entryId)}</Text>
          <Text color={tokyoNight.muted}>
            {`/rewind ${shortEntryId(item.entryId)} /fork ${shortEntryId(item.entryId)}`}
          </Text>
        </Box>
      ) : null}
      <Text color={color} wrap="wrap">
        {item.text}
      </Text>
    </Box>
  );
}

function SubagentCard({ run }: { readonly run: SubagentRunView }) {
  const color =
    run.status === 'running'
      ? tokyoNight.yellow
      : run.status === 'completed'
        ? tokyoNight.blue
        : tokyoNight.red;
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Box gap={1}>
        <Text color={color}>{run.status === 'fail' ? '×' : '↳'}</Text>
        <Text color={color}>{run.agentName}</Text>
        <Text color={tokyoNight.muted}>
          {run.background ? 'background' : 'foreground'}
        </Text>
        <Text color={tokyoNight.muted}>{formatRunDuration(run)}</Text>
      </Box>
      <Text color={tokyoNight.foreground} wrap="wrap">
        {run.description}
      </Text>
      {hiddenToolCount(run.tools) > 0 ? (
        <Text color={tokyoNight.muted}>
          {`  +${hiddenToolCount(run.tools)} earlier tool calls`}
        </Text>
      ) : null}
      {visibleSubagentTools(run.tools).map((tool) => (
        <Box key={tool.id} marginLeft={2}>
          <ToolCard call={tool} compact />
        </Box>
      ))}
      {run.status === 'running' ? (
        <Text color={tokyoNight.yellow}> running</Text>
      ) : run.status === 'fail' ? (
        <Text color={tokyoNight.red} wrap="wrap">
          {run.error}
        </Text>
      ) : run.output !== undefined && run.output.trim() !== '' ? (
        <Text color={tokyoNight.muted} wrap="wrap">
          {compactText(run.output)}
        </Text>
      ) : null}
    </Box>
  );
}

function visibleSubagentTools(
  tools: readonly ToolCallView[],
): readonly ToolCallView[] {
  return tools.slice(-SUBAGENT_VISIBLE_TOOL_LIMIT);
}

function hiddenToolCount(tools: readonly ToolCallView[]): number {
  return Math.max(0, tools.length - SUBAGENT_VISIBLE_TOOL_LIMIT);
}

function formatRunDuration(run: SubagentRunView): string {
  const start = Date.parse(run.startedAt);
  const end =
    run.completedAt !== undefined ? Date.parse(run.completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return '';
  }
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return `${seconds}s`;
}

function compactText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= 240
    ? normalized
    : `${normalized.slice(0, 239)}…`;
}

function shortEntryId(entryId: string): string {
  return entryId.slice(0, 8);
}

function hasDiffOutput(tool: ToolCallView): boolean {
  const output = tool.output;
  if (typeof output !== 'object' || output === null) {
    return false;
  }
  const metadata = (output as { metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return false;
  }
  return typeof (metadata as { diff?: unknown }).diff === 'string';
}

function compactPath(cwd: string): string {
  const home = process.env.HOME;
  const display =
    home !== undefined && cwd.startsWith(home) ? cwd.replace(home, '~') : cwd;
  if (display.length <= 68) {
    return display;
  }
  return `…${display.slice(-67)}`;
}

function formatPermission(mode: string): string {
  switch (mode) {
    case 'bypass':
      return 'YOLO mode';
    case 'dont-ask':
      return 'no prompts';
    case 'accept-edits':
      return 'auto-accept edits';
    default:
      return mode;
  }
}
