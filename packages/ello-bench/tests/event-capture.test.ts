import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEventCaptureRecorder } from '../src/event-capture.js';
import { validateEventEvidence } from '../src/event-evidence.js';
import { sha256 } from '../src/hash.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe('event capture', () => {
  it('writes ordered redacted JSONL and a complete marker', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ello-bench-events-'));
    directories.push(directory);
    const capture = createEventCaptureRecorder(
      path.join(directory, 'events.jsonl'),
    );

    await capture.recorder.record(
      {
        type: 'run.started',
        runId: 'run_1',
        sequence: 1,
        occurredAt: '2026-07-23T00:00:00.000Z',
      },
      {},
    );
    await capture.recorder.record(
      {
        type: 'tool.started',
        runId: 'run_1',
        sequence: 2,
        occurredAt: '2026-07-23T00:00:01.000Z',
        turnIndex: 1,
        toolCallId: 'call_1',
        name: 'write',
        input: {
          authorization: 'secret-value',
          nested: { apiKey: 'secret-value', retained: 'value' },
        },
      },
      {},
    );
    await capture.recorder.flush?.({});
    await capture.close();

    const lines = (await readFile(capture.eventLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { readonly payload: Record<string, unknown> },
      );
    const second = lines[1]?.payload as {
      readonly input: { readonly nested: Record<string, unknown> };
    };
    const marker = JSON.parse(await readFile(capture.completePath, 'utf8')) as {
      readonly eventCount: number;
      readonly runCount: number;
    };

    expect(second.input).not.toHaveProperty('authorization');
    expect(second.input.nested).not.toHaveProperty('apiKey');
    expect(second.input.nested.retained).toBe('value');
    expect(marker).toMatchObject({ eventCount: 2, runCount: 1 });
    await expect(capture.close()).rejects.toThrow('already closed');
  });

  it('rejects non-increasing engine event sequences', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ello-bench-events-'));
    directories.push(directory);
    const capture = createEventCaptureRecorder(
      path.join(directory, 'events.jsonl'),
    );

    await capture.recorder.record(
      {
        type: 'run.started',
        runId: 'run_1',
        sequence: 1,
        occurredAt: '2026-07-23T00:00:00.000Z',
      },
      {},
    );
    await expect(
      capture.recorder.record(
        {
          type: 'run.started',
          runId: 'run_1',
          sequence: 1,
          occurredAt: '2026-07-23T00:00:01.000Z',
        },
        {},
      ),
    ).rejects.toThrow('must increase');
    await capture.close();
  });

  it('recomputes lifecycle counts from the raw event log', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ello-bench-events-'));
    directories.push(directory);
    const eventLogPath = path.join(directory, 'engine-events-thread.jsonl');
    const content = `${[
      event(1, 'run.started'),
      event(2, 'turn.started'),
      event(3, 'model.started'),
    ]
      .map(JSON.stringify)
      .join('\n')}\n`;
    await writeFile(eventLogPath, content, 'utf8');
    const completePath = `${eventLogPath}.complete.json`;
    const marker = {
      schema: 'ello.benchmark.event-capture.complete.v1',
      eventLogPath,
      eventCount: 3,
      runCount: 1,
      turnCount: 1,
      modelCallCount: 1,
      sha256: sha256(content),
    };
    await writeFile(completePath, JSON.stringify(marker), 'utf8');

    await expect(validateEventEvidence(directory)).resolves.toEqual(marker);
    await writeFile(
      completePath,
      JSON.stringify({ ...marker, modelCallCount: 2 }),
      'utf8',
    );
    await expect(validateEventEvidence(directory)).rejects.toThrow(
      'lifecycle count mismatch',
    );
  });
});

function event(sequence: number, name: string) {
  return {
    schema: 'ello.benchmark.event-capture.v1',
    sequence,
    event: name,
    payload: {},
  };
}
