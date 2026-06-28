import type { CodingAgentEvent } from '../product/events.js';

/** 为非交互式 CLI 格式化产品事件。 */
export function formatCodingAgentEventOutput(event: CodingAgentEvent, json: boolean): string {
  if (json) {
    return `${JSON.stringify(event)}\n`;
  }
  if (event.type === 'message.delta') {
    return event.text;
  }
  if (event.type === 'tool.started') {
    return `\n[tool] ${event.call.summary}\n`;
  }
  if (event.type === 'approval.requested') {
    return `\n[approval] ${event.request.toolName}: ${event.request.reason}\n`;
  }
  if (event.type === 'run.completed') {
    return event.result.output.endsWith('\n') ? '' : '\n';
  }
  if (event.type === 'run.failed') {
    return `\n${event.error.message}\n`;
  }
  return '';
}

/** 输出顶层 CLI 帮助文本。 */
export function printHelp(): string {
  return `ello

Commands:
  ello                         Start React Ink TUI
  ello run <prompt>            Run one prompt in print mode
  ello run --json <prompt>     Run one prompt as JSONL product events
  ello rpc                     Start bidirectional JSONL/RPC over stdio
  ello resume <session>        Resume a session in TUI
  ello sessions                List sessions
  ello memory                  Show loaded memory files
  ello permissions             Show permission mode/rules
  ello config get|set|path     Manage config
  ello tools                   List default tools

Options:
  --model <name>
  --model-candidate <name>
  --base-url <url>
  --cwd <path>
  --allowed-path <path>
  --session <id>
  --mcp <path>
  --approval-mode <default|plan|accept-edits|dont-ask|bypass>
  --json
  --no-tui`;
}
