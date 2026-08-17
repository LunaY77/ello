import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  EventCaptureCompleteSchema,
  type EventCaptureComplete,
} from '../domain/contract/index.js';

import { sha256File } from './io.js';
import { forEachEventCapture } from './rounds.js';

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
  if ((await sha256File(eventLogPath)) !== complete.sha256) {
    throw new Error(`Event capture checksum mismatch: ${eventLogPath}`);
  }
  let eventCount = 0;
  let previousSequence = 0;
  let runCount = 0;
  let turnCount = 0;
  let modelCallCount = 0;
  await forEachEventCapture(eventLogPath, (capture) => {
    eventCount += 1;
    if (capture.sequence !== previousSequence + 1) {
      throw new Error(
        previousSequence === capture.sequence
          ? `Event sequence is duplicated: ${capture.sequence}.`
          : `Event sequence has a gap: expected ${previousSequence + 1}, received ${capture.sequence}.`,
      );
    }
    previousSequence = capture.sequence;
    if (capture.event === 'run.started') runCount += 1;
    if (capture.event === 'turn.started') turnCount += 1;
    if (capture.event === 'model.started') modelCallCount += 1;
  });
  if (eventCount !== complete.eventCount) {
    throw new Error(`Event capture count mismatch: ${eventLogPath}`);
  }
  if (
    runCount !== complete.runCount ||
    turnCount !== complete.turnCount ||
    modelCallCount !== complete.modelCallCount
  ) {
    throw new Error(`Event capture lifecycle count mismatch: ${eventLogPath}`);
  }
  if (runCount < 1 || turnCount < 1 || modelCallCount < 1) {
    throw new Error(
      `Event capture lifecycle is incomplete: runs=${runCount} turns=${turnCount} modelCalls=${modelCallCount}.`,
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
