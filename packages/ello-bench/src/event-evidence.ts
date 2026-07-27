import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  EventCaptureCompleteSchema,
  EventCaptureSchema,
  type EventCaptureComplete,
} from './contracts.js';
import { sha256 } from './hash.js';

export async function validateEventEvidence(
  rawRoot: string,
): Promise<EventCaptureComplete> {
  const files = (await readdir(rawRoot)).filter((name) =>
    /^engine-events-.+\.jsonl\.complete\.json$/u.test(name),
  );
  if (files.length !== 1) {
    throw new Error(
      `Expected one completed EngineEvent capture in ${rawRoot}, received ${files.length}.`,
    );
  }
  const completePath = path.join(rawRoot, required(files[0]));
  const complete = EventCaptureCompleteSchema.parse(
    JSON.parse(await readFile(completePath, 'utf8')) as unknown,
  );
  const eventLogPath = path.resolve(complete.eventLogPath);
  if (path.dirname(eventLogPath) !== path.resolve(rawRoot)) {
    throw new Error(`Event log is outside raw root: ${eventLogPath}`);
  }
  const content = await readFile(eventLogPath);
  if (sha256(content) !== complete.sha256) {
    throw new Error(`Event capture checksum mismatch: ${eventLogPath}`);
  }
  const captures = content
    .toString('utf8')
    .split(/\r?\n/u)
    .filter((line) => line !== '')
    .map((line) => EventCaptureSchema.parse(JSON.parse(line) as unknown));
  if (captures.length !== complete.eventCount) {
    throw new Error(`Event capture count mismatch: ${eventLogPath}`);
  }
  const actualCounts = captures.reduce(
    (counts, capture) => ({
      runCount: counts.runCount + (capture.event === 'run.started' ? 1 : 0),
      turnCount: counts.turnCount + (capture.event === 'turn.started' ? 1 : 0),
      modelCallCount:
        counts.modelCallCount + (capture.event === 'model.started' ? 1 : 0),
    }),
    { runCount: 0, turnCount: 0, modelCallCount: 0 },
  );
  if (
    actualCounts.runCount !== complete.runCount ||
    actualCounts.turnCount !== complete.turnCount ||
    actualCounts.modelCallCount !== complete.modelCallCount
  ) {
    throw new Error(`Event capture lifecycle count mismatch: ${eventLogPath}`);
  }
  if (
    actualCounts.runCount !== 1 ||
    actualCounts.turnCount < 1 ||
    actualCounts.modelCallCount < 1
  ) {
    throw new Error(
      `Event capture lifecycle is incomplete: runs=${actualCounts.runCount} turns=${actualCounts.turnCount} modelCalls=${actualCounts.modelCallCount}.`,
    );
  }
  // 校验序号集合本身完整（无重复、无缺口），而不是文件物理行序。行序由异步
  // 落盘决定，把它当作序号顺序的代理会把可恢复的写入乱序判成证据损坏。
  const sequences = captures.map((capture) => capture.sequence).sort((a, b) => a - b);
  for (const [index, sequence] of sequences.entries()) {
    if (sequence === index + 1) continue;
    const previous = sequences[index - 1];
    throw new Error(
      previous === sequence
        ? `Event sequence is duplicated: ${sequence}.`
        : `Event sequence has a gap: expected ${index + 1}, received ${sequence}.`,
    );
  }
  return complete;
}

function required(value: string | undefined): string {
  if (value === undefined)
    throw new Error('Missing event capture marker path.');
  return value;
}
