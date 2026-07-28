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

  it('keeps a recovered failed round without failing the completed run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-rounds-'));
    const eventLogPath = path.join(root, 'events.jsonl');
    const identity = {
      runId: 'run-1',
      turnIndex: 0,
      agentName: 'build',
      modelSelector: 'primary_model',
      configuredModel: 'benchmark-pro',
      protocol: 'openai',
      apiModel: 'model',
    };
    const first = { ...identity, modelCallId: 'call-1' };
    const second = { ...identity, modelCallId: 'call-2' };
    const lines = [
      capture(1, 'model.started', modelEvent('model.started', 1, first)),
      capture(2, 'model.failed', {
        ...modelEvent('model.failed', 2, first),
        error: {
          name: 'TypeError',
          message: 'terminated',
          cause: { code: 'UND_ERR_SOCKET' },
        },
      }),
      capture(3, 'model.started', modelEvent('model.started', 3, second)),
      capture(4, 'model.completed', {
        ...modelEvent('model.completed', 4, second),
        response: {
          finishReason: 'stop',
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 3,
            cacheWriteTokens: 0,
            toolCalls: 0,
          },
        },
      }),
      capture(5, 'tool.started', {
        type: 'tool.started',
        sequence: 5,
        runId: 'run-1',
        occurredAt: '2026-07-23T00:00:05.000Z',
        turnIndex: 0,
        toolCallId: 'tool-1',
        name: 'read',
        input: { filePath: 'README.md' },
      }),
      capture(6, 'tool.completed', {
        type: 'tool.completed',
        sequence: 6,
        runId: 'run-1',
        occurredAt: '2026-07-23T00:00:06.000Z',
        turnIndex: 0,
        toolCallId: 'tool-1',
      }),
      capture(7, 'run.completed', {
        type: 'run.completed',
        sequence: 7,
        runId: 'run-1',
        occurredAt: '2026-07-23T00:00:07.000Z',
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

    expect(normalized.providerFailure).toBe(false);
    expect(normalized.rounds).toHaveLength(2);
    expect(normalized.rounds[0]).toMatchObject({
      status: 'failed',
      error: 'TypeError: terminated [UND_ERR_SOCKET]',
      toolCalls: [],
    });
    expect(normalized.rounds[1]).toMatchObject({
      status: 'completed',
      toolCalls: [{ id: 'tool-1', name: 'read' }],
    });
    expect(normalized.tools).toHaveLength(1);
    expect(normalized.usage.status).toBe('unavailable');
  });
});

function modelEvent(
  type: string,
  sequence: number,
  identity: Record<string, unknown>,
) {
  return {
    type,
    sequence,
    runId: 'run-1',
    occurredAt: `2026-07-23T00:00:0${sequence}.000Z`,
    identity,
  };
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
