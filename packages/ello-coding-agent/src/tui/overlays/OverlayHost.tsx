import { Alert, Select } from '@inkjs/ui';
import { Box, Text } from 'ink';

import type { ApprovalDecision } from '../../runtime/intents.js';
import type { ApprovalView } from '../state/view-reducer.js';

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
  | { readonly type: 'help' };

/** 审批浮层四个选项 → 决定。 */
const APPROVAL_OPTIONS = [
  { label: 'Allow once', value: 'once' },
  { label: 'Always allow (session)', value: 'session' },
  { label: 'Always allow (project)', value: 'project' },
  { label: 'Deny', value: 'deny' },
];

export interface OverlayHostProps {
  readonly overlay: OverlayState;
  /** 审批选择回调：把 UI 选项翻译成 {@link ApprovalDecision} 交回 App。 */
  onApprove(requestId: string, decision: ApprovalDecision): void;
  /** 模型选择回调。 */
  onSelectModel(model: string): void;
}

/**
 * 单层浮层 host。
 *
 * 审批用 `Alert` + `Select`：选择结果直接翻译成 `ApprovalDecision` 交给
 * `session.approve`（在 App 里），TUI 本身不判权限。
 */
export function OverlayHost({
  overlay,
  onApprove,
  onSelectModel,
}: OverlayHostProps) {
  if (overlay.type === 'none') {
    return null;
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {overlay.type === 'approval' ? (
        <Alert variant="warning" title={`Approve ${overlay.request.toolName}?`}>
          <Box flexDirection="column">
            <Text dimColor wrap="wrap">
              {preview(overlay.request.input)}
            </Text>
            <Select
              options={APPROVAL_OPTIONS}
              onChange={(value) =>
                onApprove(overlay.request.requestId, toDecision(value))
              }
            />
          </Box>
        </Alert>
      ) : null}
      {overlay.type === 'model-selector' ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text color="cyan">Select model</Text>
          <Select
            options={overlay.models.map((model) => ({
              label: model,
              value: model,
            }))}
            onChange={onSelectModel}
          />
        </Box>
      ) : null}
      {overlay.type === 'help' ? (
        <Box borderStyle="round" paddingX={1}>
          <Text>
            /help /model /new /tools /permissions /memory /quit · Esc closes ·
            Ctrl+C exits
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** 把 Select 的 value 翻译成审批决定。 */
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
