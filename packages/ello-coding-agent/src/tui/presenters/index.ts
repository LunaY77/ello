import { Text } from 'ink';
import { createElement, type ReactNode } from 'react';

/**
 * 工具渲染注册表。
 *
 * `@ello/agent` 的 `AgentTool` 不含任何 React（内核与 UI 解耦），所以工具的渲染
 * 不能塞进工具本身。这里把渲染放到 **TUI 层的一个按工具名查找的注册表**里：
 * 加一个工具，只需在 `05` 写执行、在这里加一个 presenter，互不影响。
 */
export interface ToolPresenter<I = unknown, O = unknown> {
  /** `tool.started` 时画请求卡片（命令、路径、diff 头等）。 */
  renderCall(input: I): ReactNode;
  /** `tool.completed` 时画结果（stdout 摘要、diff、文件树…）。 */
  renderResult(input: I, output: O): ReactNode;
  /** 一行摘要，给 transcript 折叠态用。 */
  summarize(input: I): string;
}

/** 取对象上的字符串字段（找不到返回空串）。 */
function str(obj: unknown, key: string): string {
  if (typeof obj === 'object' && obj !== null) {
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

/** 兜底 presenter：没有专属渲染的工具走这里。 */
const defaultPresenter: ToolPresenter = {
  summarize: (input) => clip(JSON.stringify(input ?? {}), 60),
  renderCall: () => null,
  renderResult: (_input, output) =>
    createElement(Text, { dimColor: true }, clip(stringify(output), 200)),
};

/** read 工具：展示路径与读到的行数。 */
const readPresenter: ToolPresenter = {
  summarize: (input) => str(input, 'path'),
  renderCall: (input) => createElement(Text, { dimColor: true }, str(input, 'path')),
  renderResult: (_input, output) => {
    const total = (output as { totalLines?: number })?.totalLines;
    return createElement(Text, { dimColor: true }, total ? `${total} lines` : 'read');
  },
};

/** 写类工具（write/edit）：展示路径 + diff。 */
const diffPresenter: ToolPresenter = {
  summarize: (input) => str(input, 'path'),
  renderCall: (input) => createElement(Text, { dimColor: true }, str(input, 'path')),
  renderResult: (_input, output) =>
    createElement(Text, undefined, str(output, 'diff') || str(output, 'path')),
};

/** bash 工具：展示命令与退出码/输出摘要。 */
const bashPresenter: ToolPresenter = {
  summarize: (input) => clip(str(input, 'command'), 60),
  renderCall: (input) => createElement(Text, { dimColor: true }, str(input, 'command')),
  renderResult: (_input, output) => {
    const record = output as { exitCode?: number; stdout?: string; stderr?: string };
    const head = record?.stdout || record?.stderr || '';
    return createElement(Text, { dimColor: true }, clip(head, 200));
  },
};

/** grep 工具：展示 pattern 与命中摘要。 */
const grepPresenter: ToolPresenter = {
  summarize: (input) => clip(str(input, 'pattern'), 60),
  renderCall: (input) => createElement(Text, { dimColor: true }, str(input, 'pattern')),
  renderResult: (_input, output) => createElement(Text, { dimColor: true }, clip(stringify(output), 200)),
};

/** todo 工具：展示任务条数。 */
const todoPresenter: ToolPresenter = {
  summarize: () => 'todo',
  renderCall: () => null,
  renderResult: (_input, output) => {
    const items = (output as { items?: unknown[] })?.items;
    return createElement(Text, { dimColor: true }, `${items?.length ?? 0} items`);
  },
};

/** 工具名 → presenter 映射表。 */
export const toolPresenters: Record<string, ToolPresenter> = {
  read: readPresenter,
  write: diffPresenter,
  edit: diffPresenter,
  bash: bashPresenter,
  grep: grepPresenter,
  todo: todoPresenter,
};

/** 按工具名取 presenter，缺省走兜底。 */
export function presenterFor(name: string): ToolPresenter {
  return toolPresenters[name] ?? defaultPresenter;
}

/** 安全 JSON 化（环引用等退化为 String）。 */
function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 截断到 max 字符。 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
