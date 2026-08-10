import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  normalizeEventCapture,
  normalizeEventCaptureSource,
} from '../src/infra/rounds.js';

describe('round normalization', () => {
  it('preserves a run-level failure diagnostic without a failed model round', () => {
    const identity = {
      runId: 'run-1',
      turnIndex: 0,
      modelCallId: 'call-local',
      agentName: 'build',
      modelSelector: 'primary_model',
      configuredModel: 'benchmark-pro',
      protocol: 'openai',
      apiModel: 'model',
    };
    const source = [
      capture(1, 'model.started', modelEvent('model.started', 1, identity)),
      capture(2, 'model.completed', {
        ...modelEvent('model.completed', 2, identity),
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
      capture(3, 'run.failed', {
        type: 'run.failed',
        sequence: 3,
        runId: 'run-1',
        occurredAt: '2026-07-23T00:00:03.000Z',
        error: {
          name: 'Error',
          message:
            'Newest model input message exceeds the available context budget.',
        },
      }),
    ]
      .map(JSON.stringify)
      .join('\n');

    const normalized = normalizeEventCaptureSource(source, false);
    expect(normalized.providerFailure).toBe(false);
    expect(normalized.providerFailureMessage).toBeNull();
    expect(normalized.runFailureMessage).toContain('context budget');
  });

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
        diagnostics: modelDiagnostics(),
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
    expect(normalized.toolsetFingerprints).toEqual(['a'.repeat(64)]);
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

  it('normalizes physical commands emitted by Command Run', async () => {
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
    const record = {
      commandRunId: 'command-run:outer-1',
      commandId: 'command-run:outer-1:0',
      index: 0,
      step: 1,
      name: 'bash',
      input: { command: 'go test ./...' },
      inputDigest: 'digest',
    };
    const lines = [
      capture(1, 'model.started', modelEvent('model.started', 1, identity)),
      capture(2, 'model.completed', {
        ...modelEvent('model.completed', 2, identity),
        response: {
          finishReason: 'tool-calls',
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 3,
            cacheWriteTokens: 0,
            toolCalls: 1,
          },
          toolCalls: [
            {
              id: 'outer-1',
              name: 'command_run',
              input: { commands: [] },
            },
          ],
        },
      }),
      commandEvent(3, 'command_run.started', {
        commandRunId: 'command-run:outer-1',
        providerToolCallId: 'outer-1',
        commands: [],
      }),
      commandEvent(4, 'command.started', {
        record: {
          ...record,
          status: 'running',
          startedAt: '2026-07-23T00:00:04.000Z',
        },
      }),
      commandEvent(5, 'command.completed', {
        record: {
          ...record,
          status: 'completed',
          startedAt: '2026-07-23T00:00:04.000Z',
          completedAt: '2026-07-23T00:00:05.000Z',
        },
      }),
      commandEvent(6, 'command_run.completed', {
        commandRunId: 'command-run:outer-1',
      }),
      commandEvent(7, 'command.completed', {
        record: {
          ...record,
          commandId: 'command-run:outer-1:1',
          index: 1,
          input: { command: 'go vet ./...' },
          status: 'completed',
          startedAt: '2026-07-23T00:00:06.000Z',
          completedAt: '2026-07-23T00:00:07.000Z',
        },
      }),
      commandEvent(8, 'command.failed', {
        record: {
          ...record,
          commandId: 'command-run:outer-1:2',
          index: 2,
          name: 'apply_patch',
          input: { patch: 'invalid patch' },
          status: 'failed',
          completedAt: '2026-07-23T00:00:08.000Z',
          error: 'Invalid patch.',
        },
      }),
      capture(9, 'run.completed', {
        type: 'run.completed',
        sequence: 9,
        runId: 'run-1',
        occurredAt: '2026-07-23T00:00:09.000Z',
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

    expect(normalized.tools).toEqual([
      expect.objectContaining({
        id: 'command-run:outer-1:0',
        name: 'bash',
        category: 'shell',
        status: 'completed',
        command: 'go test ./...',
        durationMs: 1000,
      }),
      expect.objectContaining({
        id: 'command-run:outer-1:1',
        status: 'completed',
        command: 'go vet ./...',
        durationMs: 1000,
      }),
      expect.objectContaining({
        id: 'command-run:outer-1:2',
        name: 'apply_patch',
        status: 'failed',
        startedAt: null,
        durationMs: null,
      }),
    ]);
    expect(normalized.rounds[0]?.toolCalls).toHaveLength(3);
    expect(normalized.usage).toMatchObject({
      status: 'complete',
      toolCalls: 3,
    });
  });
});

function commandEvent(
  sequence: number,
  type: string,
  event: Record<string, unknown>,
) {
  const occurredAt = `2026-07-23T00:00:${String(sequence).padStart(2, '0')}.000Z`;
  return capture(sequence, 'command.event', {
    type: 'command.event',
    sequence,
    runId: 'run-1',
    occurredAt,
    event: { type, ...event, occurredAt },
  });
}

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
    ...(type === 'model.started' ? { diagnostics: modelDiagnostics() } : {}),
  };
}

function modelDiagnostics() {
  return { toolsetFingerprint: 'a'.repeat(64) };
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
