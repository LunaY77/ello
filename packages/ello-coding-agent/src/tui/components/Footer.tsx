import type { AgentUsage } from '@ello/agent';
import { Box, Text } from 'ink';

import { tokyoNight } from '../tokyo-night.js';

export interface FooterProps {
  readonly profile: string;
  readonly approvalMode: string;
  readonly usage?: AgentUsage;
  /** 上下文窗口占用比例（0~1），用于粗略展示预算。 */
  readonly contextRatio?: number;
}

/**
 * 底部状态栏。
 *
 * 展示 profile / token 用量 / 上下文占用和审批模式。
 */
export function Footer(props: FooterProps) {
  const tokens =
    props.usage !== undefined
      ? props.usage.inputTokens + props.usage.outputTokens
      : 0;
  return (
    <Box width="100%" justifyContent="space-between" paddingX={1} marginTop={1}>
      <Box gap={1} flexShrink={0}>
        <Text color={tokyoNight.muted}>{props.profile}</Text>
        <Text color={approvalColor(props.approvalMode)}>
          {`[${props.approvalMode}]`}
        </Text>
      </Box>
      <Box gap={1}>
        <Text color={tokyoNight.muted}>{`${formatTokens(tokens)} tok`}</Text>
        {props.contextRatio !== undefined ? (
          <Text color={tokyoNight.muted}>{`ctx ${Math.round(
            props.contextRatio * 100,
          )}%`}</Text>
        ) : null}
      </Box>
    </Box>
  );
}

/** 审批模式 → 文本颜色：越宽松越偏红。 */
function approvalColor(mode: string): string {
  switch (mode) {
    case 'bypass':
      return tokyoNight.red;
    case 'accept-edits':
      return tokyoNight.yellow;
    case 'dont-ask':
      return tokyoNight.purple;
    default:
      return tokyoNight.green;
  }
}

/** token 数收敛成 12.3k 形式。 */
function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
