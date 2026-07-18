import type { ThreadItem, ThreadSnapshot } from '../api/protocol-types.js';

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function writeText(value: unknown): void {
  process.stdout.write(`${formatValue(value)}\n`);
}

export function renderSnapshot(snapshot: ThreadSnapshot): void {
  writeText(`${snapshot.thread.name} ${snapshot.thread.id} [${snapshot.thread.status}]`);
  for (const turn of snapshot.turns) {
    for (const item of turn.items) writeText(renderItem(item));
  }
}

export function renderItem(item: ThreadItem): string {
  switch (item.type) {
    case 'userMessage': return `you: ${item.text}`;
    case 'agentMessage': return `assistant: ${item.text}`;
    case 'reasoning': return `reasoning: ${item.summary}`;
    case 'plan': return `plan: ${item.text}`;
    case 'commandExecution': return `command: ${item.command} (${item.status})${item.outputPreview === undefined ? '' : `\n${item.outputPreview}`}`;
    case 'fileChange': return `file changes: ${item.changes.map((change) => `${change.kind} ${change.path}`).join(', ')}`;
    case 'toolCall': return `tool: ${item.toolName} ${item.headline}`;
    case 'subagent': return `subagent: ${item.agentName} ${item.description}`;
    case 'contextCompaction': return `compaction: ${item.summary}`;
    case 'notice': return `${item.level}: ${item.message}`;
    case 'error': return `error: ${item.code}: ${item.message}`;
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
