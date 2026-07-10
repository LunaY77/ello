import { describe, expect, it } from 'vitest';

import type {
  AgentModelRequest,
  AgentModelResponse,
  AgentObserver,
  ModelAdapter,
  ModelCallCompletedEvent,
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

describe('model-call observer', () => {
  it('上报安全的 model-call usage 与 fingerprint', async () => {
    const calls: ModelCallCompletedEvent[] = [];
    const observer: AgentObserver = {
      onModelCallCompleted: (event) => calls.push(event),
    };
    const agent = createAgent({
      model: 'test:model-a',
      modelAdapter: new FinalAdapter(),
      instructions: 'stable system',
      observers: [observer],
    });

    await agent.run('hello');
    await agent.close();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      turnIndex: 0,
      provider: 'test',
      model: 'model-a',
      finishReason: 'stop',
      usage,
      compactionBoundary: false,
    });
    expect(calls[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(calls[0]?.systemFingerprint).toHaveLength(64);
    expect(calls[0]?.toolsetFingerprint).toHaveLength(64);
    expect(calls[0]?.messagePrefixFingerprint).toHaveLength(64);
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
        observers: [
          {
            onModelCallCompleted: (event) =>
              fingerprints.push(event.toolsetFingerprint),
          },
        ],
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
