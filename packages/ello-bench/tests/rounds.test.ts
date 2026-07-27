import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeEventCapture } from '../src/rounds.js';

describe('round normalization', () => {
  it('normalizes model calls and sums per-call usage', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-rounds-'));
    const eventLogPath = path.join(root, 'events.jsonl');
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
    const lines = [
      capture(1, 'model.started', {
        type: 'model.started',
        sequence: 1,
        runId: 'run-1',
        occurredAt: '2026-07-23T00:00:00.000Z',
        identity,
      }),
      capture(2, 'model.completed', {
        type: 'model.completed',
        sequence: 2,
        runId: 'run-1',
        occurredAt: '2026-07-23T00:00:02.000Z',
        firstTokenAt: '2026-07-23T00:00:00.500Z',
        identity,
        response: {
          finishReason: 'stop',
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
            toolCalls: 2,
          },
        },
      }),
    ];
    await writeFile(
      eventLogPath,
      `${lines.map(JSON.stringify).join('\n')}\n`,
      'utf8',
    );

    const normalized = await normalizeEventCapture({
      eventLogPath,
      roundsPath: path.join(root, 'rounds.jsonl'),
      allowIncomplete: false,
    });

    expect(normalized.rounds[0]).toMatchObject({
      status: 'completed',
      agentName: 'build',
      modelSelector: 'primary_model',
      configuredModel: 'benchmark-pro',
      protocol: 'openai',
      apiModel: 'model',
      durationMs: 2000,
      firstTokenLatencyMs: 500,
    });
    expect(normalized.usage).toEqual({
      status: 'complete',
      requests: 1,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      reasoningTokens: null,
      toolCalls: 0,
    });
  });
});

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
