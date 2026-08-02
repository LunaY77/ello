import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  EventCaptureCompleteSchema,
  EventCaptureSchema,
  type EventCaptureComplete,
} from '../domain/contract/index.js';
import { sha256 } from '../domain/hash.js';

export interface AgentEventEvidence {
  readonly main: EventCaptureComplete & { readonly threadId: string };
  readonly subagents: ReadonlyArray<
    EventCaptureComplete & { readonly threadId: string }
  >;
}

export async function validateEventEvidence(
  rawRoot: string,
): Promise<AgentEventEvidence> {
  const files = (await readdir(rawRoot))
    .filter((name) => /^engine-events-.+\.jsonl\.complete\.json$/u.test(name))
    .sort();
  const captures = await Promise.all(
    files.map(async (name) => {
      const threadId = threadIdFromMarker(name);
      const complete = await validateCapture(path.join(rawRoot, name), rawRoot);
      return { ...complete, threadId };
    }),
  );
  const main = captures.filter((capture) =>
    capture.threadId.startsWith('thr_'),
  );
  const subagents = captures.filter((capture) =>
    capture.threadId.startsWith('job_'),
  );
  const unknown = captures.filter(
    (capture) =>
      !capture.threadId.startsWith('thr_') &&
      !capture.threadId.startsWith('job_'),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown EngineEvent thread id prefix in ${rawRoot}: ${unknown
        .map((capture) => capture.threadId)
        .join(', ')}.`,
    );
  }
  if (main.length !== 1) {
    throw new Error(
      `Expected one completed main EngineEvent capture in ${rawRoot}, received ${main.length}.`,
    );
  }
  return { main: required(main[0]), subagents };
}

async function validateCapture(
  completePath: string,
  rawRoot: string,
): Promise<EventCaptureComplete> {
  const complete = EventCaptureCompleteSchema.parse(
    JSON.parse(await readFile(completePath, 'utf8')) as unknown,
  );
  const expectedName = path.basename(completePath, '.complete.json');
  if (path.basename(complete.eventLogPath) !== expectedName) {
    throw new Error(
      `Event capture marker path does not match its log: ${complete.eventLogPath}`,
    );
  }
  const eventLogPath = path.join(path.resolve(rawRoot), expectedName);
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
    actualCounts.runCount < 1 ||
    actualCounts.turnCount < 1 ||
    actualCounts.modelCallCount < 1
  ) {
    throw new Error(
      `Event capture lifecycle is incomplete: runs=${actualCounts.runCount} turns=${actualCounts.turnCount} modelCalls=${actualCounts.modelCallCount}.`,
    );
  }
  const sequences = captures
    .map((capture) => capture.sequence)
    .sort((a, b) => a - b);
  for (const [index, sequence] of sequences.entries()) {
    if (sequence === index + 1) continue;
    const previous = sequences[index - 1];
    throw new Error(
      previous === sequence
        ? `Event sequence is duplicated: ${sequence}.`
        : `Event sequence has a gap: expected ${index + 1}, received ${sequence}.`,
    );
  }
  return { ...complete, eventLogPath };
}

function threadIdFromMarker(name: string): string {
  const match = /^engine-events-(.+)\.jsonl\.complete\.json$/u.exec(name);
  const threadId = match?.[1];
  if (threadId === undefined || threadId === '') {
    throw new Error(`Invalid EngineEvent completion marker: ${name}`);
  }
  return threadId;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing main event capture.');
  return value;
}
