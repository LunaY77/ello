import type { CodingSessionEvent } from '../runtime/intents.js';

/**
 * CLI 事件渲染。
 *
 * CLI 与 TUI 消费同一种 {@link CodingSessionEvent}，这里只负责把事件转成
 * 给人看的文本，或在 `--json` 模式下原样序列化给脚本消费。渲染层不含任何业务
 * 逻辑——它纯粹是 `CodingSessionEvent` 到字符串的映射函数。
 *
 * @param event 来自 `CodingSession` 的一条事件。
 * @param json 为真时输出单行 JSON，便于自动化消费。
 * @returns 要写入 stdout 的字符串（可能为空串，表示该事件无需可视化）。
 */
export function renderEvent(event: CodingSessionEvent, json: boolean): string {
  if (json) {
    return `${JSON.stringify(event)}\n`;
  }
  switch (event.type) {
    case 'message.delta':
      // 助手正文增量：直接透传，拼成连续文本。
      return event.text;
    case 'tool.started':
      return `\n${dim('·')} ${bold(event.name)}(${summarizeInput(event.input)})\n`;
    case 'tool.completed':
      return `${dim(summarizeOutput(event.output))}\n`;
    case 'tool.failed':
      return red(`✗ ${event.error.message}\n`);
    case 'approval.pending':
      // 非交互 CLI 无审批 UI；提示一句，实际放行/拒绝由策略决定。
      return dim(`(awaiting approval: ${event.toolName})\n`);
    case 'run.completed':
      return '\n';
    case 'run.failed':
      return red(`\nrun failed: ${event.error.message}\n`);
    default:
      // run.started / turn.* / status / usage / session.* 等在文本模式下静默。
      return '';
  }
}

/** 把工具入参收敛成一行短摘要（截断，避免刷屏）。 */
function summarizeInput(input: unknown): string {
  if (input === undefined || input === null) {
    return '';
  }
  if (typeof input === 'object') {
    const record = input as Record<string, unknown>;
    // 优先展示最有信息量的字段：path / command / pattern。
    const key = ['path', 'command', 'pattern', 'query'].find(
      (k) => typeof record[k] === 'string',
    );
    if (key !== undefined) {
      return clip(String(record[key]), 80);
    }
  }
  return clip(typeof input === 'string' ? input : JSON.stringify(input), 80);
}

/** 把工具输出收敛成一行短摘要。 */
function summarizeOutput(output: unknown): string {
  if (output === undefined || output === null) {
    return 'done';
  }
  if (typeof output === 'object') {
    const record = output as Record<string, unknown>;
    if (typeof record.path === 'string') {
      const bytes =
        typeof record.bytes === 'number' ? ` (${record.bytes}b)` : '';
      return `→ ${record.path}${bytes}`;
    }
    if (typeof record.totalLines === 'number') {
      return `→ ${record.totalLines} lines`;
    }
  }
  return clip(
    typeof output === 'string' ? output : JSON.stringify(output),
    120,
  );
}

/** 截断到 max 字符，超出加省略号。 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// 极简 ANSI 着色：无 TTY 时退化为原文（由调用方决定是否启用）。
const useColor =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
function dim(text: string): string {
  return useColor ? `\u001b[2m${text}\u001b[0m` : text;
}
function red(text: string): string {
  return useColor ? `\u001b[31m${text}\u001b[0m` : text;
}
function bold(text: string): string {
  return useColor ? `\u001b[1m${text}\u001b[0m` : text;
}
