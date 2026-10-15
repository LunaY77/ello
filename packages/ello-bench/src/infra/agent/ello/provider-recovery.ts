import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeEventCaptures, readEventCaptures } from '../../rounds.js';

export interface ElloProviderRecoveryTarget {
  readonly threadId: string;
  readonly eventLogPath: string;
}

export function buildElloProviderRecoveryInstruction(
  originalInstruction: string,
): string {
  return `The previous turn ended because the model provider connection failed after bounded retries. Continue in the same thread and workspace. Inspect the existing progress, finish the implementation, run the relevant tests, and report the result. Do not restart from scratch. Do not ask whether to continue ordinary implementation or verification.\n\nOriginal task:\n${originalInstruction}`;
}

export async function findElloProviderRecoveryTarget(options: {
  readonly stdoutPath: string;
  readonly eventRoot: string;
}): Promise<ElloProviderRecoveryTarget | null> {
  const threadId = parseSingleThreadId(
    await readFile(options.stdoutPath, 'utf8'),
  );
  if (threadId === null) return null;
  if (!/^[A-Za-z0-9_-]+$/u.test(threadId)) {
    throw new Error(`Ello emitted an invalid thread id: ${threadId}`);
  }
  const eventLogPath = path.resolve(
    options.eventRoot,
    `engine-events-${threadId}.jsonl`,
  );
  if (path.dirname(eventLogPath) !== path.resolve(options.eventRoot)) {
    throw new Error(
      `Ello recovery event log escaped its root: ${eventLogPath}`,
    );
  }
  const normalized = normalizeEventCaptures(
    await readEventCaptures(eventLogPath),
    false,
  );
  return normalized.providerFailure ? { threadId, eventLogPath } : null;
}

function parseSingleThreadId(source: string): string | null {
  const ids = new Set<string>();
  for (const line of source.split(/\r?\n/u)) {
    if (line === '') continue;
    const value = JSON.parse(line) as unknown;
    if (typeof value !== 'object' || value === null) continue;
    const params = Reflect.get(value, 'params');
    if (typeof params !== 'object' || params === null) continue;
    const threadId = Reflect.get(params, 'threadId');
    if (typeof threadId === 'string' && threadId !== '') ids.add(threadId);
  }
  if (ids.size === 0) return null;
  if (ids.size > 1) {
    throw new Error(
      `Ello stdout contains multiple thread ids: ${[...ids].join(', ')}`,
    );
  }
  return ids.values().next().value ?? null;
}
