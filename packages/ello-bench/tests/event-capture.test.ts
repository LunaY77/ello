import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import { createEventCaptureRecorder } from '../src/infra/event-capture.js';
import { validateEventEvidence } from '../src/infra/event-evidence.js';

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
    await capture.recorder.record(
      {
        type: 'run.started',
        runId: 'run_2',
        sequence: 1,
        occurredAt: '2026-07-23T00:00:02.000Z',
      },
      {},
    );
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
    expect(lines.map((line) => line.payload.sequence)).toEqual([1, 2, 1]);
    expect(marker).toMatchObject({ eventCount: 3, runCount: 2 });
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

  it('appends after recorder restart without losing sequence state', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ello-bench-events-'));
    directories.push(directory);
    const eventLogPath = path.join(directory, 'events.jsonl');
    const initial = createEventCaptureRecorder(eventLogPath);

    await initial.recorder.record(
      {
        type: 'run.started',
        runId: 'run_1',
        sequence: 1,
        occurredAt: '2026-07-23T00:00:00.000Z',
      },
      {},
    );
    await initial.close();

    const resumed = createEventCaptureRecorder(eventLogPath);
    await resumed.recorder.record(
      {
        type: 'turn.started',
        runId: 'run_1',
        sequence: 2,
        occurredAt: '2026-07-23T00:00:01.000Z',
        turnIndex: 1,
      },
      {},
    );
    await resumed.close();

    const captures = (await readFile(eventLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly sequence: number;
            readonly event: string;
          },
      );
    const marker = JSON.parse(await readFile(resumed.completePath, 'utf8')) as {
      readonly eventCount: number;
      readonly turnCount: number;
    };

    expect(captures).toEqual([
      expect.objectContaining({ sequence: 1, event: 'run.started' }),
      expect.objectContaining({ sequence: 2, event: 'turn.started' }),
    ]);
    expect(marker).toMatchObject({ eventCount: 2, turnCount: 1 });
  });

  it('recomputes lifecycle counts from the raw event log', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ello-bench-events-'));
    directories.push(directory);
    const eventLogPath = path.join(directory, 'engine-events-thr_main.jsonl');
    const content = `${[
      event(1, 'run.started'),
      event(2, 'turn.started'),
      event(3, 'model.started'),
      event(4, 'run.started'),
    ]
      .map(JSON.stringify)
      .join('\n')}\n`;
    await writeFile(eventLogPath, content, 'utf8');
    const completePath = `${eventLogPath}.complete.json`;
    const marker = {
      schema: 'ello.benchmark.event-capture.complete.v1',
      eventLogPath,
      eventCount: 4,
      runCount: 2,
      turnCount: 1,
      modelCallCount: 1,
      sha256: sha256(content),
    };
    await writeFile(completePath, JSON.stringify(marker), 'utf8');

    const subagentLogPath = path.join(
      directory,
      'engine-events-job_subagent.jsonl',
    );
    const subagentContent = `${[
      event(1, 'run.started'),
      event(2, 'turn.started'),
      event(3, 'model.started'),
    ]
      .map(JSON.stringify)
      .join('\n')}\n`;
    await writeFile(subagentLogPath, subagentContent, 'utf8');
    const subagentMarker = {
      schema: 'ello.benchmark.event-capture.complete.v1',
      eventLogPath: subagentLogPath,
      eventCount: 3,
      runCount: 1,
      turnCount: 1,
      modelCallCount: 1,
      sha256: sha256(subagentContent),
    };
    await writeFile(
      `${subagentLogPath}.complete.json`,
      JSON.stringify(subagentMarker),
      'utf8',
    );

    await expect(validateEventEvidence(directory)).resolves.toEqual({
      main: { ...marker, threadId: 'thr_main' },
      subagents: [{ ...subagentMarker, threadId: 'job_subagent' }],
    });
    await writeFile(
      completePath,
      JSON.stringify({ ...marker, modelCallCount: 2 }),
      'utf8',
    );
    await expect(validateEventEvidence(directory)).rejects.toThrow(
      'lifecycle count mismatch',
    );
  });

  it('rejects captures whose thread id has an unknown prefix', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ello-bench-events-'));
    directories.push(directory);
    await writeCapture(directory, 'thr_main');
    await writeCapture(directory, 'session_unknown');

    await expect(validateEventEvidence(directory)).rejects.toThrow(
      'Unknown EngineEvent thread id prefix',
    );
  });
});

async function writeCapture(
  directory: string,
  threadId: string,
): Promise<void> {
  const eventLogPath = path.join(directory, `engine-events-${threadId}.jsonl`);
  const content = `${[
    event(1, 'run.started'),
    event(2, 'turn.started'),
    event(3, 'model.started'),
  ]
    .map(JSON.stringify)
    .join('\n')}\n`;
  await writeFile(eventLogPath, content, 'utf8');
  await writeFile(
    `${eventLogPath}.complete.json`,
    JSON.stringify({
      schema: 'ello.benchmark.event-capture.complete.v1',
      eventLogPath,
      eventCount: 3,
      runCount: 1,
      turnCount: 1,
      modelCallCount: 1,
      sha256: sha256(content),
    }),
    'utf8',
  );
}

function event(sequence: number, name: string) {
  return {
    schema: 'ello.benchmark.event-capture.v1',
    sequence,
    event: name,
    payload: {},
  };
}
