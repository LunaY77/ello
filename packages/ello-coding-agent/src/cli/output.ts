import type { CodingAgentEvent } from '../session.js';

/**
 * 为非交互式 CLI 格式化流式会话事件。
 */
export function formatCodingAgentEventOutput(
  event: CodingAgentEvent,
  json: boolean,
): string {
  if (json) {
    return `${JSON.stringify(event)}\n`;
  }
  if (event.type === 'core_event' && event.event.type === 'message.delta') {
    return event.event.text;
  }
  if (event.type === 'run_finished') {
    return event.success ? '\n' : `\n${event.error ?? ''}\n`;
  }
  return '';
}

/**
 * 输出顶层 CLI 帮助文本。
 */
export function printHelp(): string {
  return `ello

Commands:
  ello                    Start Ink TUI
  ello run <prompt>       Run one non-interactive prompt
  ello resume [session]   Resume a session in TUI
  ello sessions           List sessions
  ello memory             Show loaded memory files
  ello permissions        Show permission mode/rules
  ello tasks              Show task manager status
  ello config get|set|path Manage config
  ello tools list         List default tools

Options:
  --model <name>
  --model-candidate <name>
  --base-url <url>
  --cwd <path>
  --allowed-path <path>
  --session <id>
  --mcp <path>
  --approval-mode <never|on-request|always>
  --json
  --no-tui`;
}
