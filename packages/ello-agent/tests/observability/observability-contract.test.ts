import type { Span, Tracer } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import type {
  AgentRunContext,
  EngineEvent,
} from '../../src/agent/engine/index.js';
import { contentAttributes } from '../../src/observability/content-policy.js';
import { createLangfuseEventRecorder } from '../../src/observability/langfuse-recorder.js';
import type { LangfuseTracingRuntime } from '../../src/observability/langfuse-runtime.js';

const occurredAt = '2026-07-19T00:00:00.000Z';
const diagnostics = {
  systemFingerprint: 's'.repeat(64),
  toolsetFingerprint: 't'.repeat(64),
  messagePrefixFingerprint: 'm'.repeat(64),
  compactionBoundary: false,
};
const usage = {
  requests: 1,
  inputTokens: 12,
  outputTokens: 3,
  cacheReadTokens: 4,
  cacheWriteTokens: 2,
  toolCalls: 0,
};

describe('observability contract', () => {
  it('metadata policy 仅记录长度与摘要，不记录 prompt、tool output 或 credential', () => {
    const payload = {
      prompt: 'private prompt',
      authorization: 'Bearer secret-token',
      output: 'private tool output',
    };

    const attributes = contentAttributes('metadata', 'input', payload);
    const serialized = JSON.stringify(attributes);

    expect(attributes['ello.input.bytes']).toBeGreaterThan(0);
    expect(attributes['ello.input.sha256']).toMatch(/^[a-f\d]{64}$/u);
    expect(serialized).not.toContain('private prompt');
    expect(serialized).not.toContain('private tool output');
    expect(serialized).not.toContain('secret-token');
    expect(attributes).not.toHaveProperty('langfuse.observation.input');
  });

  it('完整 model lifecycle 关联 usage、fingerprint，并在 run 结束后 flush', async () => {
    const fixture = tracingFixture();
    const recorder = createLangfuseEventRecorder({
      runtime: fixture.runtime,
      agentKind: 'primary',
    });
    const context = runContext();

    for (const event of successfulEvents()) {
      await recorder.record(event, context);
    }
    await recorder.flush?.(context);

    const generation = fixture.spans.find((span) =>
      span.name.startsWith('llm.'),
    );
    expect(generation?.attributes).toMatchObject({
      'langfuse.observation.type': 'generation',
      'langfuse.observation.model.name': 'model-a',
      'ello.model.provider': 'test',
      'ello.model.fingerprints': JSON.stringify(diagnostics),
      'ello.model.finish_reason': 'stop',
    });
    expect(
      JSON.parse(
        String(generation?.attributes['langfuse.observation.usage_details']),
      ),
    ).toEqual({ input: 12, output: 3, cache_read: 4, cache_write: 2 });
    expect(JSON.stringify(fixture.spans)).not.toContain('private prompt');
    expect(JSON.stringify(fixture.spans)).not.toContain('secret-token');
    expect(fixture.forceFlush).toHaveBeenCalledWith('run_obs');
    expect(fixture.spans.every((span) => span.ended)).toBe(true);
  });

  it('model call 失败时结束 generation span 并记录明确错误', async () => {
    const fixture = tracingFixture();
    const recorder = createLangfuseEventRecorder({
      runtime: fixture.runtime,
      agentKind: 'primary',
    });
    const context = runContext();
    const events = successfulEvents();
    for (const event of events.slice(0, 3)) {
      await recorder.record(event!, context);
    }
    const started = events[2] as Extract<
      EngineEvent,
      { type: 'model.started' }
    >;
    await recorder.record(
      {
        runId: 'run_obs',
        sequence: 4,
        occurredAt,
        type: 'model.failed',
        identity: started.identity,
        error: { name: 'ProviderError', message: 'provider unavailable' },
        diagnostics,
        startedAt: occurredAt,
      },
      context,
    );

    const generation = fixture.spans.find((span) =>
      span.name.startsWith('llm.'),
    );
    expect(generation).toMatchObject({
      ended: true,
      exceptions: [{ name: 'ProviderError', message: 'provider unavailable' }],
    });
    expect(generation?.attributes.status).toMatchObject({
      message: 'provider unavailable',
    });
  });

  it('事件序列不连续时明确失败，避免生成无法关联的 trace', async () => {
    const fixture = tracingFixture();
    const recorder = createLangfuseEventRecorder({
      runtime: fixture.runtime,
      agentKind: 'primary',
    });
    const context = runContext();
    await recorder.record(successfulEvents()[0]!, context);

    expect(() =>
      recorder.record(
        { ...successfulEvents()[1]!, sequence: 3 } as EngineEvent,
        context,
      ),
    ).toThrow('Trace event sequence is not contiguous');
  });

  it('recorder flush 失败必须向调用方传播', async () => {
    const fixture = tracingFixture();
    fixture.forceFlush.mockRejectedValue(new Error('telemetry unavailable'));
    const recorder = createLangfuseEventRecorder({
      runtime: fixture.runtime,
      agentKind: 'primary',
    });
    const context = runContext();
    for (const event of successfulEvents()) {
      await recorder.record(event, context);
    }

    await expect(recorder.flush?.(context)).rejects.toThrow(
      'telemetry unavailable',
    );
  });
});

function successfulEvents(): EngineEvent[] {
  const identity = {
    runId: 'run_obs',
    turnIndex: 0,
    modelCallId: 'model_call_obs',
    provider: 'test',
    model: 'model-a',
  };
  const metadata = (sequence: number) => ({
    runId: 'run_obs',
    sequence,
    occurredAt,
  });
  return [
    { ...metadata(1), type: 'run.started' },
    { ...metadata(2), type: 'turn.started', turnIndex: 0 },
    {
      ...metadata(3),
      type: 'model.started',
      identity,
      request: {
        runId: 'run_obs',
        model: 'test:model-a',
        system: 'private prompt',
        messages: [{ role: 'user', content: 'Bearer secret-token' }],
        tools: {},
        modelSettings: {},
        signal: new AbortController().signal,
      },
      diagnostics,
    },
    {
      ...metadata(4),
      type: 'model.completed',
      identity,
      response: {
        text: 'private model output',
        messages: [{ role: 'assistant', content: 'private model output' }],
        newMessages: [{ role: 'assistant', content: 'private model output' }],
        usage,
        finishReason: 'stop',
        provider: null,
      },
      diagnostics,
      startedAt: occurredAt,
    },
    { ...metadata(5), type: 'turn.completed', turnIndex: 0 },
    {
      ...metadata(6),
      type: 'run.completed',
      finishReason: 'stop',
      usage,
    },
  ];
}

function runContext(): AgentRunContext<unknown> {
  return {
    runId: 'run_obs',
    agentName: 'build',
    input: 'observe',
    options: {},
    environment: {},
    metadata: {},
    context: undefined,
    signal: new AbortController().signal,
  };
}

function tracingFixture() {
  const spans: RecordingSpan[] = [];
  const tracer = {
    startSpan: vi.fn((name: string) => {
      const span = new RecordingSpan(name);
      spans.push(span);
      return span as unknown as Span;
    }),
  } as unknown as Tracer;
  const forceFlush = vi.fn().mockResolvedValue(undefined);
  const runtime: LangfuseTracingRuntime = {
    tracer,
    sessionId: 'session_obs',
    config: {
      enabled: true,
      base_url: 'https://langfuse.example.test',
      environment: 'test',
      release: 'contract',
      content: 'metadata',
    },
    registerChildRun: vi.fn(),
    consumeChildRun: vi.fn(),
    forceFlush,
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  return { spans, forceFlush, runtime };
}

class RecordingSpan {
  readonly attributes: Record<string, unknown> = {};
  readonly events: string[] = [];
  readonly exceptions: unknown[] = [];
  ended = false;

  constructor(readonly name: string) {}

  setAttribute(key: string, value: unknown): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Record<string, unknown>): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  addEvent(name: string): this {
    this.events.push(name);
    return this;
  }

  recordException(error: unknown): void {
    this.exceptions.push(error);
  }

  setStatus(status: unknown): this {
    this.attributes.status = status;
    return this;
  }

  end(): void {
    this.ended = true;
  }
}
