import type {
  FileChange,
  ThreadSnapshot,
  ThreadSummary,
  ThreadSettings,
  Usage,
} from '../api/protocol-types.js';

export const fixtureTimestamp = '2026-07-18T00:00:00.000Z';

export function createFileChange(
  path: string,
  previous: string | null,
  next: string | null,
): FileChange {
  const kind = previous === null ? 'add' : next === null ? 'delete' : 'modify';
  const oldLines = splitLines(previous);
  const newLines = splitLines(next);
  const diff = [
    `@@ -1,${Math.max(1, oldLines.length)} +1,${Math.max(1, newLines.length)} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
  return {
    path,
    kind,
    additions: newLines.length,
    deletions: oldLines.length,
    diff,
  };
}

function splitLines(value: string | null): readonly string[] {
  if (value === null || value === '') return [];
  return (value.endsWith('\n') ? value.slice(0, -1) : value).split('\n');
}

export function fixtureUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
    ...overrides,
  };
}

export function fixtureThreadSummary(
  overrides: Partial<ThreadSummary> = {},
): ThreadSummary {
  return {
    id: 'thread-1',
    rootId: 'thread-1',
    cwd: '/workspace',
    name: 'thread 1',
    preview: 'first prompt',
    status: 'idle',
    archived: false,
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
    ...overrides,
  };
}

export function fixtureSettings(
  overrides: Partial<ThreadSettings> = {},
): ThreadSettings {
  return {
    mode: 'ask-before-changes',
    profile: 'main',
    model: 'openai/gpt-5.5',
    agent: 'build',
    ...overrides,
  };
}

export function fixtureSnapshot(
  overrides: Partial<ThreadSnapshot> = {},
): ThreadSnapshot {
  return {
    thread: fixtureThreadSummary(),
    settings: fixtureSettings(),
    turns: [],
    pendingServerRequests: [],
    goal: null,
    plan: null,
    usage: fixtureUsage(),
    seq: 0,
    ...overrides,
  };
}
