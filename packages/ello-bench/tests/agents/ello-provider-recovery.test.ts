import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findElloProviderRecoveryTarget } from '../../src/agents/ello/provider-recovery.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Ello provider recovery', () => {
  it('finds a failed live capture from structured CLI notifications', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-provider-recovery-'));
    directories.push(root);
    const stdoutPath = path.join(root, 'stdout.jsonl');
    const eventRoot = path.join(root, 'adapter');
    const eventLogPath = path.join(
      eventRoot,
      'engine-events-thr_recovery.jsonl',
    );
    await mkdir(eventRoot, { recursive: true });
    await writeFile(
      stdoutPath,
      `${JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thr_recovery' },
      })}\n`,
      'utf8',
    );
    await writeFile(eventLogPath, failedCapture(), 'utf8');

    await expect(
      findElloProviderRecoveryTarget({ stdoutPath, eventRoot }),
    ).resolves.toEqual({ threadId: 'thr_recovery', eventLogPath });
  });

  it('does not recover a successfully completed run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-provider-recovery-'));
    directories.push(root);
    const stdoutPath = path.join(root, 'stdout.jsonl');
    const eventRoot = path.join(root, 'adapter');
    await mkdir(eventRoot, { recursive: true });
    await writeFile(
      stdoutPath,
      `${JSON.stringify({ params: { threadId: 'thr_complete' } })}\n`,
      'utf8',
    );
    await writeFile(
      path.join(eventRoot, 'engine-events-thr_complete.jsonl'),
      failedCapture('run.completed'),
      'utf8',
    );

    await expect(
      findElloProviderRecoveryTarget({ stdoutPath, eventRoot }),
    ).resolves.toBeNull();
  });
});

function failedCapture(
  terminal: 'run.failed' | 'run.completed' = 'run.failed',
): string {
  const identity = {
    runId: 'run-1',
    turnIndex: 0,
    modelCallId: 'call-1',
    agentName: 'build',
    modelSelector: 'primary_model',
    configuredModel: 'benchmark-pro',
    protocol: 'openai',
    apiModel: 'model',
  };
  return `${[
    capture(1, 'model.started', {
      type: 'model.started',
      sequence: 1,
      runId: 'run-1',
      occurredAt: '2026-07-23T00:00:00.000Z',
      identity,
    }),
    capture(2, 'model.failed', {
      type: 'model.failed',
      sequence: 2,
      runId: 'run-1',
      occurredAt: '2026-07-23T00:00:01.000Z',
      identity,
      error: { name: 'TypeError', message: 'terminated' },
    }),
    capture(3, terminal, {
      type: terminal,
      sequence: 3,
      runId: 'run-1',
      occurredAt: '2026-07-23T00:00:02.000Z',
    }),
  ]
    .map(JSON.stringify)
    .join('\n')}\n`;
}

function capture(
  sequence: number,
  event: string,
  payload: Record<string, unknown>,
) {
  return {
    schema: 'ello.benchmark.event-capture.v1',
    sequence,
    event,
    payload,
  };
}
