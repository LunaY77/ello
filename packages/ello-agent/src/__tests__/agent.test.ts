import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgent,
  createLocalEnvironment,
  createMemorySession,
  DefaultAgentMessageQueue,
  AgentRunControl,
  defineTool,
  trimHistoryReducer,
  tokenBudgetReducer,
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

  it('drains message queues in stable modes and run-control order', () => {
    const all = new DefaultAgentMessageQueue<string>('all');
    all.push('a');
    all.push('b');
    expect(all.drain()).toEqual(['a', 'b']);

    const one = new DefaultAgentMessageQueue<string>('one-at-a-time');
    one.push('a');
    one.push('b');
    expect(one.drain()).toEqual(['a']);
    expect(one.drain()).toEqual(['b']);

    const control = new AgentRunControl('run_1');
    control.sessionQueue.push({ role: 'user', content: 'session' });
    control.pushInput({ role: 'user', content: 'input' });
    control.pushSteering({ role: 'user', content: 'steer' });
    control.pushFollowUp({ role: 'user', content: 'follow' });

    const first = control.drainNextTurn();
    expect(first.messages.map((message) => (message as { content: string }).content)).toEqual([
      'session',
      'input',
      'steer',
      'follow',
    ]);

    control.pushInput({ role: 'user', content: 'second' });
    const second = control.drainNextTurn();
    expect(second.messages.map((message) => (message as { content: string }).content)).toEqual([
      'second',
    ]);
    expect(second.diagnostics.find((item) => item.queue === 'session')?.count).toBe(0);
  });

  it('plans with session, memory, observers, and reducers', async () => {
    const seenMessages: AgentModelRequest[] = [];
    let sessionLoads = 0;
    const session = {
      async load() {
        sessionLoads += 1;
        return [{ role: 'user', content: 'history' }] as const;
      },
      async append() {},
    };
    const observed: string[] = [];
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: {
        async generate(request) {
          seenMessages.push(request);
          return new EchoAdapter().generate(request);
        },
        async *stream(request) {
          seenMessages.push(request);
          yield { type: 'final', response: await new EchoAdapter().generate(request) };
        },
      },
      instructions: 'Be precise.',
      session,
      memory: {
        retrieve: () => [
          {
            kind: 'memory',
            source: 'test.memory',
            priority: 600,
            scope: 'workspace',
            retention: 'compressible',
            persist: 'memory',
            text: 'remembered fact',
            memoryType: 'semantic',
          },
        ],
        observe: (event) => observed.push(event.type),
      },
      reducers: [trimHistoryReducer({ maxMessages: 3 }), tokenBudgetReducer({ maxInputTokens: 1000 })],
      observers: [
        {
          onModelCallPlanned: () => observed.push('planned'),
        },
      ],
    });
    const result = await agent.run('current', { sessionId: 'sess_1' });

    expect(sessionLoads).toBe(1);
    expect(seenMessages[0]?.system).toContain('Be precise.');
    expect(seenMessages[0]?.messages.map((message) => message.role)).toContain('user');
    expect(result.diagnostics?.context?.reducerReports.map((report) => report.reducer)).toEqual([
      'trim-history',
      'token-budget',
    ]);
    expect(observed).toContain('planned');
    expect(observed).toContain('run.completed');
    await agent.close();
  });

  it('returns pending approvals without executing the tool', async () => {
    const toolCall = defineTool({
      name: 'danger',
      description: 'Dangerous tool',
      input: z.object({ value: z.string() }),
      approval: () => 'required',
      execute: () => {
        throw new Error('should not execute');
      },
    });
    const toolsSeen: AgentModelRequest[] = [];
    const agent = createAgent({
      model: 'test:model',
      tools: [toolCall],
      modelAdapter: {
        async generate(request) {
          toolsSeen.push(request);
          const execute = request.tools.danger?.execute;
          if (execute === undefined) {
            throw new Error('missing tool');
          }
          await execute({ value: 'x' }, { toolCallId: 'call_1', messages: [] });
          return new EchoAdapter().generate(request);
        },
        async *stream(request) {
          yield { type: 'final', response: await this.generate(request) };
        },
      },
    });
    const result = await agent.run('use tool');

    expect(toolsSeen.length).toBe(1);
    expect(result.pending?.[0]).toMatchObject({
      kind: 'approval',
      toolCallId: 'call_1',
      toolName: 'danger',
    });
    expect(result.finishReason).toBe('tool-calls');
    await agent.close();
  });

  it('keeps stream events for slow consumers', async () => {
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: new EchoAdapter(),
    });
    const stream = agent.stream('hi');
    await stream.final;
    const events = [];
    for await (const event of stream) {
      events.push(event.type);
    }
    expect(events).toContain('run.started');
    expect(events).toContain('message.delta');
    expect(events).toContain('run.completed');
    await agent.close();
  });
});
