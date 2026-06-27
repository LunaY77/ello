import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgent,
  createLocalEnvironment,
  createMemorySession,
  defineTool,
  z,
  type AgentModelEvent,
  type AgentModelRequest,
  type AgentModelResponse,
  type ModelAdapter,
} from '../index.js';
import { createFilesystemTools } from '../presets/index.js';

class EchoAdapter implements ModelAdapter {
  async generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    return {
      text: 'hello',
      messages: [...request.messages, { role: 'assistant', content: 'hello' }],
      usage: {
        requests: 1,
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolCalls: 0,
      },
      finishReason: 'stop',
      provider: { ok: true },
    };
  }

  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent> {
    yield { type: 'text-delta', text: 'he' };
    yield { type: 'text-delta', text: 'llo' };
    yield { type: 'final', response: await this.generate(request) };
  }
}

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('createAgent', () => {
  it('returns the same result shape from run and stream.final', async () => {
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: new EchoAdapter(),
    });
    const result = await agent.run('hi');
    const stream = agent.stream('hi');
    const events = [];
    for await (const event of stream) {
      events.push(event.type);
    }
    const final = await stream.final;

    expect(result.output).toBe('hello');
    expect(final.output).toBe('hello');
    expect(events).toContain('message.delta');
    await agent.close();
  });

  it('defines tools and emits stable tool events with custom adapters', async () => {
    const toolCall = defineTool({
      name: 'echo',
      description: 'Echo input',
      input: z.object({ text: z.string() }),
      execute: ({ text }) => text,
    });
    const seenToolNames: string[] = [];
    const adapter: ModelAdapter = {
      async generate(request) {
        seenToolNames.push(...Object.keys(request.tools));
        return new EchoAdapter().generate(request);
      },
      async *stream(request) {
        seenToolNames.push(...Object.keys(request.tools));
        yield { type: 'final', response: await new EchoAdapter().generate(request) };
      },
    };
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: adapter,
      tools: [toolCall],
    });
    const result = await agent.run('hi');

    expect(result.output).toBe('hello');
    expect(seenToolNames).toContain('echo');
    await agent.close();
  });

  it('uses local environment and memory session extensions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ello-agent-'));
    dirs.push(dir);
    const environment = createLocalEnvironment({ cwd: dir, allowedPaths: [dir] });
    await environment.files?.writeText('note.txt', 'content');
    const entries = await environment.files?.listDir('.');
    const session = createMemorySession();
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: new EchoAdapter(),
      environment,
      extensions: [session],
      tools: createFilesystemTools(),
    });
    await agent.run('remember');

    expect(entries).toContain('note.txt');
    expect(session.messages.length).toBeGreaterThan(0);
    await agent.close();
  });
});
