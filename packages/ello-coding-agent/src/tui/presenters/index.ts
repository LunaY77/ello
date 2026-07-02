import { Box, Text } from 'ink';
import { createElement, type ReactNode } from 'react';

import type { ToolResultView } from '../store/history-entry.js';
import { useTheme } from '../theme/index.js';

export interface ToolPresenter<I = unknown, O = unknown> {
  renderCall(input: I): ReactNode;
  renderResult(input: I, output: O): ReactNode;
  summarize(input: I): string;
}

function str(obj: unknown, key: string): string {
  if (typeof obj === 'object' && obj !== null) {
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

function MutedText({ children }: { readonly children: ReactNode }) {
  const theme = useTheme();
  return createElement(Text, { color: theme.textMuted }, children);
}

const defaultPresenter: ToolPresenter = {
  summarize: (input) => clip(JSON.stringify(input ?? {}), 60),
  renderCall: () => null,
  renderResult: (_input, output) =>
    createElement(
      MutedText,
      null,
      clip(readToolOutput(output) ?? stringify(output), 200),
    ),
};

const readPresenter: ToolPresenter = {
  summarize: (input) => str(input, 'path'),
  renderCall: (input) => createElement(MutedText, null, str(input, 'path')),
  renderResult: (_input, output) => {
    const metadata = readToolMetadata(output);
    const total = readNumber(metadata, 'totalLines');
    const entryCount = readNumber(metadata, 'entryCount');
    const rendered =
      total !== undefined
        ? `${total} lines`
        : entryCount !== undefined
          ? `${entryCount} entries`
          : (readToolOutput(output) ?? 'read');
    return createElement(MutedText, null, rendered);
  },
};

const diffPresenter: ToolPresenter = {
  summarize: (input) => str(input, 'path'),
  renderCall: (input) => createElement(MutedText, null, str(input, 'path')),
  renderResult: (_input, output) =>
    createElement(DiffPreview, {
      diff: readString(readToolMetadata(output), 'diff'),
      file: readString(readToolMetadata(output), 'path'),
    }),
};

const bashPresenter: ToolPresenter = {
  summarize: (input) => clip(str(input, 'command'), 60),
  renderCall: (input) => createElement(MutedText, null, str(input, 'command')),
  renderResult: (_input, output) => {
    const head = readToolOutput(output) ?? '';
    return createElement(MutedText, null, clip(head, 200));
  },
};

const grepPresenter: ToolPresenter = {
  summarize: (input) => clip(str(input, 'pattern'), 60),
  renderCall: (input) => createElement(MutedText, null, str(input, 'pattern')),
  renderResult: (_input, output) =>
    createElement(MutedText, null, clip(stringify(output), 200)),
};

const taskPresenter: ToolPresenter = {
  summarize: (input) => str(input, 'id') || 'tasks',
  renderCall: () => null,
  renderResult: (_input, output) => {
    const items = Array.isArray(output) ? output : undefined;
    const task = output as { id?: string; subject?: string };
    return createElement(
      MutedText,
      null,
      items !== undefined
        ? `${items.length} tasks`
        : task.id !== undefined
          ? `task ${task.id}: ${task.subject ?? ''}`
          : clip(stringify(output), 120),
    );
  },
};

export const toolPresenters: Record<string, ToolPresenter> = {
  read: readPresenter,
  write: diffPresenter,
  edit: diffPresenter,
  bash: bashPresenter,
  grep: grepPresenter,
  task_create: taskPresenter,
  task_list: taskPresenter,
  task_get: taskPresenter,
  task_update: taskPresenter,
  task_delete: taskPresenter,
  task_claim: taskPresenter,
  task_reset: taskPresenter,
};

export function presenterFor(name: string): ToolPresenter {
  return toolPresenters[name] ?? defaultPresenter;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function DiffPreview({
  diff,
  file,
  maxLines = 80,
}: {
  readonly diff: string;
  readonly file?: string;
  readonly maxLines?: number;
}): ReactNode {
  const theme = useTheme();
  const lines = normalizeUnifiedDiff(diff).slice(0, maxLines);
  return createElement(
    Box,
    { flexDirection: 'column' },
    file !== undefined && file !== ''
      ? createElement(Text, { color: theme.textMuted }, file)
      : null,
    ...lines.map((line, index) =>
      createElement(
        Text,
        {
          key: `${index}:${line}`,
          color: diffLineColor(line),
          wrap: 'truncate',
        },
        line,
      ),
    ),
  );

  function diffLineColor(line: string): string {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return theme.diffAdded;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      return theme.diffRemoved;
    }
    if (line.startsWith('@@')) {
      return theme.markdownHeading;
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      return theme.textMuted;
    }
    return theme.text;
  }
}

function readToolMetadata(output: unknown): Record<string, unknown> {
  if (typeof output !== 'object' || output === null) {
    return {};
  }
  const metadata = (output as ToolResultView).metadata;
  return metadata ?? {};
}

function readToolOutput(output: unknown): string | undefined {
  if (typeof output === 'object' && output !== null) {
    const value = (output as ToolResultView).output;
    return typeof value === 'string' ? value : undefined;
  }
  return typeof output === 'string' ? output : undefined;
}

function readString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = obj[key];
  return typeof value === 'number' ? value : undefined;
}

function normalizeUnifiedDiff(diff: string): string[] {
  if (diff.trim() === '') {
    return ['(no diff)'];
  }
  return diff.split(/\r?\n/u).filter((line) => line.length > 0);
}
