import type { CodingAgentEvent } from '@ello/coding-agent';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import React from 'react';

/**
 * 以紧凑提示框渲染当前审批请求。
 */
export function ToolApprovalPanel(props: {
  request: Extract<CodingAgentEvent, { type: 'approval_request' }> | null;
  draft: string;
  onDraftChange: (value: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onEdit: (value: string) => void | Promise<void>;
  editing: boolean;
}) {
  if (!props.request) {
    return null;
  }
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="yellow">{`approval ${props.request.toolName}`}</Text>
      <Text>{props.request.risk}</Text>
      <Text>{JSON.stringify(props.request.input)}</Text>
      <TextInput
        value={props.draft}
        onChange={props.onDraftChange}
        onSubmit={props.onEdit}
        focus={props.editing}
      />
      <Text color="gray">e edit mode, enter submit edit, a approve, d reject, esc close overlay</Text>
    </Box>
  );
}
