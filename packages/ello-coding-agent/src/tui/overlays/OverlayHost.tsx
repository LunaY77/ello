import { Box, Text } from 'ink';

import type { ApprovalRequestView } from '../../product/events.js';

export type OverlayState =
  | { readonly type: 'none' }
  | { readonly type: 'approval'; readonly request: ApprovalRequestView }
  | { readonly type: 'model-selector'; readonly models: readonly string[] }
  | { readonly type: 'session-selector' }
  | { readonly type: 'session-tree' }
  | { readonly type: 'settings' }
  | { readonly type: 'command-palette' }
  | { readonly type: 'permission-rules' }
  | { readonly type: 'help' };

/** overlay stack 的单层 host。 */
export function OverlayHost({ overlay }: { readonly overlay: OverlayState }) {
  if (overlay.type === 'none') return null;
  return (
    <Box borderStyle="double" paddingX={1} flexDirection="column" marginTop={1}>
      <Text color="magenta">{overlay.type}</Text>
      {overlay.type === 'approval' ? (
        <>
          <Text>{`tool     ${overlay.request.toolName}`}</Text>
          <Text>{`risk     ${overlay.request.risk}`}</Text>
          <Text dimColor wrap="wrap">{`input    ${previewValue(overlay.request.input)}`}</Text>
          <Text wrap="wrap">{`reason   ${overlay.request.reason}`}</Text>
          <Text dimColor>[a] approve once  [A] always allow  [d] deny</Text>
        </>
      ) : null}
      {overlay.type === 'model-selector' ? overlay.models.map((model) => <Text key={model}>{model}</Text>) : null}
      {overlay.type === 'session-selector' ? <Text>Sessions are loaded from the JSONL repository.</Text> : null}
      {overlay.type === 'session-tree' ? <Text>Session tree uses the JSONL leaf and branch records.</Text> : null}
      {overlay.type === 'settings' ? <Text>Settings are sourced from config and runtime snapshot.</Text> : null}
      {overlay.type === 'command-palette' ? <Text>/help /model /settings /resume /new /tree /fork /compact /tools /permissions /memory /export /quit</Text> : null}
      {overlay.type === 'permission-rules' ? <Text>Permission rules: default, user, project, local, CLI and session decisions.</Text> : null}
      {overlay.type === 'help' ? <Text>/help /model /settings /resume /new /tree /fork /compact /tools /permissions /memory /export /quit</Text> : null}
    </Box>
  );
}

function previewValue(value: unknown): string {
  if (value === undefined) {
    return '-';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 240)} ...` : text;
}
