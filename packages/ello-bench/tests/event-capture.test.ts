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

  it('把 model 请求投影成摘要，并在保留字段里防住递归与超深结构', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ello-bench-events-'));
    directories.push(directory);
    const capture = createEventCaptureRecorder(
      path.join(directory, 'events.jsonl'),
    );
    const inputSchema: Record<string, unknown> = { type: 'object' };
    inputSchema.self = inputSchema;
    const shared = { type: 'string' };
    inputSchema.left = shared;
    inputSchema.right = shared;
    let deeplyNested = inputSchema;
    for (let depth = 0; depth < 70; depth += 1) {
      const child: Record<string, unknown> = {};
      deeplyNested.child = child;
      deeplyNested = child;
    }

    await capture.recorder.record(
      {
        type: 'model.started',
        runId: 'run_1',
        sequence: 1,
        occurredAt: '2026-07-23T00:00:00.000Z',
        identity: {
          runId: 'run_1',
          turnIndex: 0,
          modelCallId: 'call_1',
          agentName: 'build',
          modelSelector: 'primary_model',
          configuredModel: 'benchmark-pro',
          protocol: 'openai',
          apiModel: 'model',
        },
        request: {
          runId: 'run_1',
          model: 'model',
          messages: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'second' },
          ],
          tools: {
            command_run: {
              description: 'Run commands.',
              inputSchema: inputSchema as never,
            },
          },
          modelSettings: { recursion: inputSchema as never },
          signal: new AbortController().signal,
        },
        diagnostics: {
          systemFingerprint: 'a'.repeat(64),
          toolsetFingerprint: 'b'.repeat(64),
          messagePrefixFingerprint: 'c'.repeat(64),
          compactionBoundary: false,
        },
      },
      {},
    );
    await capture.close();

    const recorded = JSON.parse(
      await readFile(capture.eventLogPath, 'utf8'),
    ) as {
      readonly payload: {
        readonly request?: unknown;
        readonly requestSummary: {
          readonly messageCount: number;
          readonly toolCount: number;
          readonly modelSettings: {
            readonly recursion: {
              readonly self: unknown;
              readonly child: Record<string, unknown>;
            };
          };
        };
        readonly diagnostics: { readonly toolsetFingerprint: string };
      };
    };
    // 完整 model input 是二次增长的来源，不再逐轮归档；计数保留，避免看成本来就没有。
    expect(recorded.payload.request).toBeUndefined();
    expect(recorded.payload.requestSummary).toMatchObject({
      messageCount: 2,
      toolCount: 1,
    });
    const retained = recorded.payload.requestSummary.modelSettings.recursion;
    expect(retained.self).toBe('[Circular]');
    expect(retained).toMatchObject({
      left: { type: 'string' },
      right: { type: 'string' },
    });
    let truncated: unknown = retained.child;
    for (let depth = 0; depth < 60; depth += 1) {
      truncated = (truncated as Record<string, unknown>).child;
    }
    expect(truncated).toBe('[Truncated]');
    expect(recorded.payload.diagnostics.toolsetFingerprint).toBe(
      'b'.repeat(64),
    );
  });

  it('model.completed 只归档判决所需字段，不留完整响应文本', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ello-bench-events-'));
    directories.push(directory);
    const capture = createEventCaptureRecorder(
      path.join(directory, 'events.jsonl'),
    );
    const identity = {
      runId: 'run_1',
      turnIndex: 0,
      modelCallId: 'call_1',
      agentName: 'build',
      modelSelector: 'primary_model',
      configuredModel: 'benchmark-pro',
      protocol: 'openai',
      apiModel: 'model',
    } as const;

    await capture.recorder.record(
      {
        type: 'model.completed',
        runId: 'run_1',
        sequence: 1,
        occurredAt: '2026-07-23T00:00:02.000Z',
        startedAt: '2026-07-23T00:00:00.000Z',
        identity,
        response: {
          text: 'x'.repeat(4096),
          messages: [{ role: 'assistant', content: 'x'.repeat(4096) }],
          newMessages: [{ role: 'assistant', content: 'x'.repeat(4096) }],
          toolCalls: [
            {
              id: 'call_tool_1',
              name: 'command_run',
              input: { huge: 'y'.repeat(4096) },
            },
          ],
          finishReason: 'tool-calls',
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            toolCalls: 1,
          },
        },
        diagnostics: {
          systemFingerprint: 'a'.repeat(64),
          toolsetFingerprint: 'b'.repeat(64),
          messagePrefixFingerprint: 'c'.repeat(64),
          compactionBoundary: false,
        },
      } as never,
      {},
    );
    await capture.close();

    const line = await readFile(capture.eventLogPath, 'utf8');
    const recorded = JSON.parse(line) as {
      readonly payload: { readonly response: Record<string, unknown> };
    };

    expect(recorded.payload.response).toEqual({
      finishReason: 'tool-calls',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolCalls: 1,
      },
      toolCalls: [{ id: 'call_tool_1', name: 'command_run' }],
      textLength: 4096,
      messageCount: 1,
      newMessageCount: 1,
    });
    expect(line).not.toContain('y'.repeat(64));
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

  it('maps a mounted container event path to the marker-adjacent host file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ello-bench-events-'));
    directories.push(directory);
    await writeCapture(directory, 'thr_main');
    const eventLogPath = path.join(directory, 'engine-events-thr_main.jsonl');
    const completePath = `${eventLogPath}.complete.json`;
    const marker = JSON.parse(await readFile(completePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      completePath,
      JSON.stringify({
        ...marker,
        eventLogPath:
          '/tmp/ello-bench/raw-agent/adapter/engine-events-thr_main.jsonl',
      }),
      'utf8',
    );

    await expect(validateEventEvidence(directory)).resolves.toMatchObject({
      main: { threadId: 'thr_main', eventLogPath },
    });
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
