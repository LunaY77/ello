import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeEventCapture } from '../src/infra/rounds.js';

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

  it('keeps tool ownership separate when recovered runs reuse turn indexes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-rounds-'));
    const eventLogPath = path.join(root, 'events.jsonl');
    const firstIdentity = {
      runId: 'run-1',
      turnIndex: 0,
      modelCallId: 'call-1',
      agentName: 'build',
      modelSelector: 'primary_model',
      configuredModel: 'benchmark-pro',
      protocol: 'openai',
      apiModel: 'model',
    };
    const secondIdentity = {
      ...firstIdentity,
      runId: 'run-2',
      modelCallId: 'call-2',
    };
    const completedUsage = {
      finishReason: 'stop',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        toolCalls: 1,
      },
    };
    const lines = [
      capture(
        1,
        'model.started',
        modelEvent('model.started', 1, firstIdentity),
      ),
      capture(2, 'model.completed', {
        ...modelEvent('model.completed', 2, firstIdentity),
        response: completedUsage,
      }),
      toolEvent(3, 'tool.started', 'run-1', 'tool-1'),
      toolEvent(4, 'tool.completed', 'run-1', 'tool-1'),
      capture(5, 'run.failed', {
        type: 'run.failed',
        sequence: 5,
        runId: 'run-1',
        occurredAt: '2026-07-23T00:00:05.000Z',
      }),
      capture(
        6,
        'model.started',
        modelEvent('model.started', 1, secondIdentity),
      ),
      capture(7, 'model.completed', {
        ...modelEvent('model.completed', 2, secondIdentity),
        response: completedUsage,
      }),
      toolEvent(8, 'tool.started', 'run-2', 'tool-2'),
      toolEvent(9, 'tool.completed', 'run-2', 'tool-2'),
      capture(10, 'run.completed', {
        type: 'run.completed',
        sequence: 5,
        runId: 'run-2',
        occurredAt: '2026-07-23T00:00:10.000Z',
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
    expect(normalized.rounds[0]?.toolCalls).toMatchObject([{ id: 'tool-1' }]);
    expect(normalized.rounds[1]?.toolCalls).toMatchObject([{ id: 'tool-2' }]);
  });
});

function toolEvent(
  sequence: number,
  event: 'tool.started' | 'tool.completed',
  runId: string,
  toolCallId: string,
) {
  return capture(sequence, event, {
    type: event,
    sequence,
    runId,
    occurredAt: `2026-07-23T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    turnIndex: 0,
    toolCallId,
    ...(event === 'tool.started'
      ? { name: 'read', input: { filePath: 'README.md' } }
      : {}),
  });
}

function modelEvent(
  type: string,
  sequence: number,
  identity: Record<string, unknown>,
) {
  return {
    type,
    sequence,
    runId: identity.runId,
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
