import { describe, expect, it } from 'vitest';

import type {
  AgentEventRecorder,
  AgentModelRequest,
  AgentModelResponse,
  AgentStreamEvent,
  ModelAdapter,
} from '../index.js';
import { createAgent, defineTool, z } from '../index.js';

const usage = {
  requests: 1,
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 1,
  toolCalls: 0,
};

class FinalAdapter implements ModelAdapter {
  async generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    const message = { role: 'assistant' as const, content: 'done' };
    return {
      text: 'done',
      messages: [...request.messages, message],
      newMessages: [message],
      usage,
      finishReason: 'stop',
      provider: null,
    };
  }

  async *stream(request: AgentModelRequest) {
    yield { type: 'final' as const, response: await this.generate(request) };
  }
}

describe('model-call lifecycle', () => {
  it('上报安全的 model-call usage 与 fingerprint', async () => {
    const calls: Extract<AgentStreamEvent, { type: 'model.completed' }>[] = [];
    const recorder: AgentEventRecorder = {
      record: (event) => {
        if (event.type === 'model.completed') calls.push(event);
      },
    };
    const agent = createAgent({
      model: 'test:model-a',
      modelAdapter: new FinalAdapter(),
      instructions: 'stable system',
      eventRecorder: recorder,
    });

    await agent.run('hello');
    await agent.close();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      identity: { turnIndex: 0, provider: 'test', model: 'model-a' },
      response: { finishReason: 'stop', usage },
      diagnostics: { compactionBoundary: false },
    });
    expect(
      Date.parse(calls[0]!.occurredAt) - Date.parse(calls[0]!.startedAt),
    ).toBeGreaterThanOrEqual(0);
    expect(calls[0]?.diagnostics.systemFingerprint).toHaveLength(64);
    expect(calls[0]?.diagnostics.toolsetFingerprint).toHaveLength(64);
    expect(calls[0]?.diagnostics.messagePrefixFingerprint).toHaveLength(64);
  });

  it('工具 schema 变化会改变 toolset fingerprint', async () => {
    const fingerprints: string[] = [];
    const runWithSchema = async (input: z.ZodType): Promise<void> => {
      const agent = createAgent({
        model: 'test:model-a',
        modelAdapter: new FinalAdapter(),
        tools: [
          defineTool({
            name: 'lookup',
            description: 'Lookup a value',
            input,
            execute: () => 'unused',
          }),
        ],
        eventRecorder: {
          record: (event) => {
            if (event.type === 'model.completed') {
              fingerprints.push(event.diagnostics.toolsetFingerprint);
            }
          },
        },
      });
      await agent.run('hello');
      await agent.close();
    };

    await runWithSchema(z.object({ key: z.string() }));
    await runWithSchema(z.object({ key: z.number() }));

    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
  });
});
