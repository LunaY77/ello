import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import type { CodingAgentConfig } from '../../config.js';
import type { ApprovalDecision } from '../../runtime/intents.js';
import type {
  JsonlSessionSummary,
  SessionTreeView,
} from '../../session/repository.js';
import { InlineSelect } from '../components/InlineSelect.js';
import type { ApprovalView } from '../state/view-reducer.js';
import { tokyoNight } from '../tokyo-night.js';

/**
 * 浮层状态。
 *
 * v1 保留三类浮层：审批（最高优先级，`approval.pending` 自动弹出）、help、
 * 模型选择。其余浮层（会话树/设置等）留作后续。
 */
export type OverlayState =
  | { readonly type: 'none' }
  | { readonly type: 'approval'; readonly request: ApprovalView }
  | { readonly type: 'model-selector'; readonly models: readonly string[] }
  | { readonly type: 'help' }
  | { readonly type: 'settings'; readonly config: CodingAgentConfig }
  | {
      readonly type: 'session-selector';
      readonly sessions: readonly JsonlSessionSummary[];
    }
  | { readonly type: 'session-tree'; readonly tree: SessionTreeView };

/** 审批浮层四个选项 → 决定。 */
const APPROVAL_OPTIONS = [
  { label: 'Allow once', value: 'once' },
  { label: 'Always allow (session)', value: 'session' },
  { label: 'Always allow (project)', value: 'project' },
  { label: 'Deny', value: 'deny' },
];

export interface OverlayHostProps {
  readonly overlay: OverlayState;
  readonly marginTop?: number;
  /** 审批选择回调：把 UI 选项翻译成 {@link ApprovalDecision} 交回 App。 */
  onApprove(requestId: string, decision: ApprovalDecision): void;
  /** 模型选择回调。 */
  onSelectModel(model: string): void;
  /** session 选择回调。 */
  onSelectSession?(sessionId: string): void;
  /** session tree checkout 回调。 */
  onCheckout?(entryId: string | null): void;
}

/**
 * 单层浮层 host。
 *
 * 审批选择结果直接翻译成 `ApprovalDecision` 交给 `session.approve`
 * （在 App 里），TUI 本身不判权限。
 */
export function OverlayHost({
  overlay,
  marginTop = 1,
  onApprove,
  onSelectModel,
  onSelectSession = () => {},
  onCheckout = () => {},
}: OverlayHostProps) {
  if (overlay.type === 'none') {
    return null;
  }
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      {overlay.type === 'approval' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={tokyoNight.yellow}
          paddingX={1}
        >
          <Text color={tokyoNight.yellow}>{`Approve ${overlay.request.toolName}?`}</Text>
          <Text color={tokyoNight.muted} wrap="wrap">
            {preview(overlay.request.input)}
          </Text>
          <InlineSelect
            options={APPROVAL_OPTIONS}
            onChange={(value) =>
              onApprove(overlay.request.requestId, toDecision(value))
            }
          />
        </Box>
      ) : null}
      {overlay.type === 'model-selector' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={tokyoNight.blue}
          paddingX={1}
        >
          <Text color={tokyoNight.cyan}>Select model</Text>
          <InlineSelect
            options={overlay.models.map((model) => ({
              label: model,
              value: model,
            }))}
            onChange={onSelectModel}
          />
        </Box>
      ) : null}
      {overlay.type === 'help' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={tokyoNight.surface}
          paddingX={1}
        >
          <Text color={tokyoNight.cyan}>Commands</Text>
          <Text color={tokyoNight.foreground} wrap="wrap">
            /help /model /new /tools /permissions /memory /quit
          </Text>
          <Text color={tokyoNight.muted}>
            @path attaches files · !cmd runs shell · Esc closes or interrupts
          </Text>
        </Box>
      ) : null}
      {overlay.type === 'settings' ? (
        <Panel title="Settings" color={tokyoNight.purple}>
          <SettingLine label="model" value={overlay.config.model} />
          <SettingLine label="base url" value={overlay.config.baseUrl ?? '<default>'} />
          <SettingLine
            label="headers"
            value={`${Object.keys(overlay.config.httpHeaders).length} custom`}
          />
          <SettingLine label="sessions" value={overlay.config.sessionDir} />
          <SettingLine label="cwd" value={overlay.config.cwd} />
        </Panel>
      ) : null}
      {overlay.type === 'session-selector' ? (
        <Panel title="Resume Session" color={tokyoNight.blue}>
          <InlineSelect
            options={
              overlay.sessions.length > 0
                ? overlay.sessions.map((session) => ({
                    value: session.sessionId,
                    label: renderResumeLabel(session),
                  }))
                : [{ value: '', label: 'No sessions found' }]
            }
            onChange={(value) => {
              if (value !== '') {
                onSelectSession(value);
              }
            }}
          />
        </Panel>
      ) : null}
      {overlay.type === 'session-tree' ? (
        <Panel title="Session Tree" color={tokyoNight.cyan}>
          <InlineSelect
            options={[
              { value: '<root>', label: 'checkout root' },
              ...overlay.tree.nodes.map((node) => ({
                value: node.id,
                label: renderTreeLabel(node, overlay.tree),
              })),
            ]}
            onChange={(value) => onCheckout(value === '<root>' ? null : value)}
          />
        </Panel>
      ) : null}
    </Box>
  );
}

function Panel({
  title,
  color,
  children,
}: {
  readonly title: string;
  readonly color: string;
  readonly children: ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
    >
      <Text color={color}>{title}</Text>
      {children}
    </Box>
  );
}

function SettingLine({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <Text>
      <Text color={tokyoNight.muted}>{label.padEnd(10)}</Text>
      <Text color={tokyoNight.foreground}>{value}</Text>
    </Text>
  );
}

/** 把选项 value 翻译成审批决定。 */
function toDecision(value: string): ApprovalDecision {
  switch (value) {
    case 'session':
      return { action: 'always_allow', scope: 'session' };
    case 'project':
      return { action: 'always_allow', scope: 'project' };
    case 'deny':
      return { action: 'deny' };
    default:
      return { action: 'approve_once' };
  }
}

/** 入参预览（截断）。 */
function preview(value: unknown): string {
  if (value === undefined) {
    return '-';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 240)} …` : text;
}

function compactPath(value: string): string {
  return value.length <= 48 ? value : `…${value.slice(-47)}`;
}

function renderResumeLabel(session: JsonlSessionSummary): string {
  const bits = [
    `${session.sessionId.slice(0, 8)}`,
    compactPath(session.cwd),
  ];
  if (session.lastUserText !== undefined) {
    bits.push(`you: ${clip(session.lastUserText, 36)}`);
  }
  if (session.lastAssistantText !== undefined) {
    bits.push(`ello: ${clip(session.lastAssistantText, 36)}`);
  }
  if (session.lastToolText !== undefined) {
    bits.push(`tool: ${clip(session.lastToolText, 36)}`);
  }
  return bits.join('  ');
}

function renderTreeLabel(
  node: SessionTreeView['nodes'][number],
  tree: SessionTreeView,
): string {
  const prefix = node.active ? '●' : '○';
  const path = renderEntryPath(tree, node.id);
  return `${prefix} ${path}  ${clip(node.label, 44)}`;
}

function renderEntryPath(tree: SessionTreeView, entryId: string): string {
  const chain: string[] = [];
  let current: string | null = entryId;
  while (current !== null) {
    const node = tree.nodes.find((item) => item.id === current);
    if (node === undefined) {
      break;
    }
    chain.push(node.label);
    current = node.parentId;
  }
  return chain.reverse().join(' › ');
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
