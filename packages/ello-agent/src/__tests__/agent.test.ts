import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgent,
  createLocalEnvironment,
  createLocalShellEnvironment,
  defineTool,
  z,
  type AgentModelEvent,
  type AgentModelRequest,
  type AgentModelResponse,
  type ModelAdapter,
} from '../index.js';
import {
  AgentRunControl,
  DefaultAgentMessageQueue,
  trimMessages,
} from '../internal.js';

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
        yield {
          type: 'final',
          response: await new EchoAdapter().generate(request),
        };
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

  it('uses local environment and session store', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ello-agent-'));
    dirs.push(dir);
    const environment = createLocalEnvironment({
      cwd: dir,
      allowedPaths: [dir],
    });
    await environment.fileSystem?.writeText('note.txt', 'content');
    const entries = await environment.fileSystem?.listDir('.');
    const savedMessages: unknown[] = [];
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: new EchoAdapter(),
      environment,
      session: {
        async load() {
          return [];
        },
        async append(_sessionId, messages) {
          savedMessages.push(...messages);
        },
      },
      tools: [
        defineTool({
          name: 'read_note',
          description: 'Read note file',
          input: z.object({ path: z.string() }),
          execute: ({ path }, ctx) =>
            ctx.environment.fileSystem?.readText(path) ?? '',
        }),
      ],
    });
    await agent.run('remember', { sessionId: 'sess_1' });

    expect(entries).toContain('note.txt');
    expect(savedMessages.length).toBeGreaterThan(0);
    await agent.close();
  });

  it('runs environment lifecycle and resource instructions inside the agent loop', async () => {
    const events: string[] = [];
    const requests: AgentModelRequest[] = [];
    const environment = createLocalShellEnvironment();
    environment.resources?.register('test-resource', {
      setup: () => events.push('resource.setup'),
      getContextInstructions: () => 'Resource instruction.',
      close: () => events.push('resource.close'),
    });
    const originalSetup = environment.setup?.bind(environment);
    const originalClose = environment.close?.bind(environment);
    environment.setup = async (ctx) => {
      events.push(`setup:${ctx.runId.length > 0}`);
      await originalSetup?.(ctx);
    };
    environment.onEvent = (event) => events.push(event.type);
    environment.close = async () => {
      events.push('close');
      await originalClose?.();
    };
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: {
        async generate(request) {
          requests.push(request);
          return new EchoAdapter().generate(request);
        },
        async *stream(request) {
          requests.push(request);
          yield {
            type: 'final',
            response: await new EchoAdapter().generate(request),
          };
        },
      },
      environment,
    });

    await agent.run('hi');
    const shellResult = await environment.shell?.run('echo shell-ok');
    await agent.close();

    expect(events[0]).toBe('setup:true');
    expect(events).toContain('resource.setup');
    expect(events).toContain('run.started');
    expect(events).toContain('run.completed');
    expect(events).toContain('close');
    expect(events).toContain('resource.close');
    expect(shellResult?.stdout.trim()).toBe('shell-ok');
    expect(requests[0]?.system).toContain('<environment-context>');
    expect(requests[0]?.system).toContain('<file-system>');
    expect(requests[0]?.system).toContain('<shell>');
    expect(requests[0]?.system).toContain('Resource instruction.');
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
    expect(
      first.messages.map((message) => (message as { content: string }).content),
    ).toEqual(['session', 'input', 'steer', 'follow']);

    control.pushInput({ role: 'user', content: 'second' });
    const second = control.drainNextTurn();
    expect(
      second.messages.map(
        (message) => (message as { content: string }).content,
      ),
    ).toEqual(['second']);
    expect(
      second.diagnostics.find((item) => item.queue === 'session')?.count,
    ).toBe(0);
  });

  it('builds model input with session, memory, observers, and transforms', async () => {
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
          yield {
            type: 'final',
            response: await new EchoAdapter().generate(request),
          };
        },
      },
      instructions: 'Be precise.',
      session,
      memory: {
        retrieve: () => [
          {
            text: 'remembered fact',
          },
        ],
        observe: (event) => observed.push(event.type),
      },
      modelInput: {
        systemSections: [() => 'Working directory: /tmp/project'],
        messageTransforms: [trimMessages({ maxMessages: 3 })],
        providerOptions: () => ({ test: { enabled: true } }),
      },
      observers: [
        {
          onTurnStarted: () => observed.push('turn-started'),
        },
      ],
    });
    const result = await agent.run('current', { sessionId: 'sess_1' });

    expect(sessionLoads).toBe(1);
    expect(seenMessages[0]?.system).toContain('Be precise.');
    expect(seenMessages[0]?.system).toContain(
      'Working directory: /tmp/project',
    );
    expect(seenMessages[0]?.system).toContain('remembered fact');
    expect(seenMessages[0]?.providerOptions).toEqual({
      test: { enabled: true },
    });
    expect(seenMessages[0]?.messages.map((message) => message.role)).toContain(
      'user',
    );
    expect(
      result.diagnostics?.modelInput?.appliedMessageTransforms.length,
    ).toBeGreaterThan(0);
    expect(observed).toContain('turn-started');
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
          return {
            text: '',
            messages: [...request.messages],
            newMessages: [],
            toolCalls: [
              { id: 'call_1', name: 'danger', input: { value: 'x' } },
            ],
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              toolCalls: 0,
            },
            finishReason: 'tool-calls',
            provider: null,
          };
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
    expect(result.pending).toHaveLength(1);
    expect(result.finishReason).toBe('approval-required');
    await agent.close();
  });

  it('continues the loop after tool-calls and builds input once per turn', async () => {
    const requests: AgentModelRequest[] = [];
    const observed: string[] = [];
    const agent = createAgent({
      model: 'test:model',
      observers: [
        {
          onTurnStarted: () => observed.push('turn-started'),
        },
      ],
      modelAdapter: {
        async generate(request) {
          requests.push(request);
          if (requests.length === 1) {
            return {
              text: '',
              messages: [
                ...request.messages,
                { role: 'assistant', content: 'tool result ready' },
              ],
              newMessages: [
                { role: 'assistant', content: 'tool result ready' },
              ],
              usage: {
                requests: 1,
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                toolCalls: 0,
              },
              finishReason: 'tool-calls',
              provider: null,
            };
          }
          return {
            text: 'done',
            messages: [
              ...request.messages,
              { role: 'assistant', content: 'done' },
            ],
            newMessages: [{ role: 'assistant', content: 'done' }],
            usage: {
              requests: 1,
              inputTokens: 1,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              toolCalls: 0,
            },
            finishReason: 'stop',
            provider: null,
          };
        },
        async *stream(request) {
          yield { type: 'final', response: await this.generate(request) };
        },
      },
    });

    const result = await agent.run('hi');

    expect(result.output).toBe('done');
    expect(result.finishReason).toBe('stop');
    expect(requests).toHaveLength(2);
    expect(observed).toEqual(['turn-started', 'turn-started']);
    expect(result.diagnostics?.turns).toHaveLength(2);
    await agent.close();
  });

  it('loads session history once and does not duplicate it on the second plan', async () => {
    const seen = [] as string[][];
    let loads = 0;
    const agent = createAgent({
      model: 'test:model',
      session: {
        async load() {
          loads += 1;
          return [{ role: 'user', content: 'history' }];
        },
        async append() {},
      },
      modelAdapter: {
        async generate(request) {
          seen.push(request.messages.map((message) => String(message.content)));
          const isFirst = seen.length === 1;
          return {
            text: isFirst ? '' : 'done',
            messages: [
              ...request.messages,
              { role: 'assistant', content: isFirst ? 'tool result' : 'done' },
            ],
            newMessages: [
              { role: 'assistant', content: isFirst ? 'tool result' : 'done' },
            ],
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              toolCalls: 0,
            },
            finishReason: isFirst ? 'tool-calls' : 'stop',
            provider: null,
          };
        },
        async *stream(request) {
          yield { type: 'final', response: await this.generate(request) };
        },
      },
    });

    await agent.run('current', { sessionId: 'sess_1' });

    expect(loads).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.filter((content) => content === 'history')).toHaveLength(1);
    expect(seen[1]?.filter((content) => content === 'history')).toHaveLength(1);
    await agent.close();
  });

  it('stops at maxTurns without a second model call', async () => {
    let calls = 0;
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: {
        async generate(request) {
          calls += 1;
          return {
            text: '',
            messages: [
              ...request.messages,
              { role: 'assistant', content: 'again' },
            ],
            newMessages: [{ role: 'assistant', content: 'again' }],
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              toolCalls: 0,
            },
            finishReason: 'tool-calls',
            provider: null,
          };
        },
        async *stream(request) {
          yield { type: 'final', response: await this.generate(request) };
        },
      },
    });

    const result = await agent.run('hi', { maxTurns: 1 });

    expect(calls).toBe(1);
    expect(result.finishReason).toBe('length');
    await agent.close();
  });

  it('stops tool-calls without new messages as no-progress', async () => {
    let calls = 0;
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: {
        async generate(request) {
          calls += 1;
          return {
            text: '',
            messages: [...request.messages],
            newMessages: [],
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              toolCalls: 0,
            },
            finishReason: 'tool-calls',
            provider: null,
          };
        },
        async *stream(request) {
          yield { type: 'final', response: await this.generate(request) };
        },
      },
    });

    const result = await agent.run('hi');

    expect(calls).toBe(1);
    expect(result.finishReason).toBe('no-progress');
    await agent.close();
  });

  it('prefers response.newMessages over diff fallback', async () => {
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: {
        async generate(request) {
          return {
            text: 'from-new-messages',
            messages: [...request.messages],
            newMessages: [{ role: 'assistant', content: 'from-new-messages' }],
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              toolCalls: 0,
            },
            finishReason: 'stop',
            provider: null,
          };
        },
        async *stream(request) {
          yield { type: 'final', response: await this.generate(request) };
        },
      },
    });

    const result = await agent.run('hi');

    expect(result.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'from-new-messages',
    });
    expect(result.finishReason).toBe('stop');
    await agent.close();
  });

  it('resume approval injects a tool result and continues the loop', async () => {
    const firstAgent = createAgent({
      model: 'test:model',
      tools: [
        defineTool({
          name: 'danger',
          description: 'Dangerous tool',
          input: z.object({ value: z.string() }),
          approval: () => 'required',
          execute: () => 'should not run',
        }),
      ],
      modelAdapter: {
        async generate(request) {
          return {
            text: '',
            messages: [...request.messages],
            newMessages: [],
            toolCalls: [
              { id: 'call_1', name: 'danger', input: { value: 'x' } },
            ],
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              toolCalls: 0,
            },
            finishReason: 'tool-calls',
            provider: null,
          };
        },
        async *stream(request) {
          yield { type: 'final', response: await this.generate(request) };
        },
      },
    });
    const pending = await firstAgent.run('use tool');
    const resumedRequests: AgentModelRequest[] = [];
    const resumedAgent = createAgent({
      model: 'test:model',
      tools: [
        defineTool({
          name: 'danger',
          description: 'Dangerous tool',
          input: z.object({ value: z.string() }),
          approval: () => 'required',
          execute: () => 'approved-output',
        }),
      ],
      modelAdapter: {
        async generate(request) {
          resumedRequests.push(request);
          return {
            text: 'approved',
            messages: [
              ...request.messages,
              { role: 'assistant', content: 'approved' },
            ],
            newMessages: [{ role: 'assistant', content: 'approved' }],
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              toolCalls: 0,
            },
            finishReason: 'stop',
            provider: null,
          };
        },
        async *stream(request) {
          yield { type: 'final', response: await this.generate(request) };
        },
      },
    });

    const result = await resumedAgent.run([], {
      resume: {
        deferred: pending.pending ?? [],
        approvals: { call_1: true },
      },
    });

    expect(result.output).toBe('approved');
    expect(resumedRequests[0]?.messages.map((message) => message.role)).toEqual(
      ['assistant', 'tool'],
    );
    expect(JSON.stringify(resumedRequests[0]?.messages[1])).toContain(
      '"type":"text"',
    );
    expect(JSON.stringify(resumedRequests[0]?.messages[1])).toContain(
      'approved-output',
    );
    expect(result.diagnostics?.resumeSource).toBe('options.resume');
    await firstAgent.close();
    await resumedAgent.close();
  });

  it('stream emits turn and queue events across multiple turns', async () => {
    let calls = 0;
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: {
        async generate(request) {
          calls += 1;
          const first = calls === 1;
          return {
            text: first ? '' : 'done',
            messages: [
              ...request.messages,
              { role: 'assistant', content: first ? 'tool result' : 'done' },
            ],
            newMessages: [
              { role: 'assistant', content: first ? 'tool result' : 'done' },
            ],
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              toolCalls: 0,
            },
            finishReason: first ? 'tool-calls' : 'stop',
            provider: null,
          };
        },
        async *stream(request) {
          yield { type: 'text-delta', text: 'x' };
          yield { type: 'final', response: await this.generate(request) };
        },
      },
    });

    const stream = agent.stream('hi');
    const events = [];
    for await (const event of stream) {
      events.push(event.type);
    }
    const result = await stream.final;

    expect(result.diagnostics?.turns).toHaveLength(2);
    expect(events.filter((event) => event === 'turn.started')).toHaveLength(2);
    expect(
      events.filter((event) => event === 'queue.drained').length,
    ).toBeGreaterThan(4);
    expect(events.filter((event) => event === 'turn.completed')).toHaveLength(
      2,
    );
    expect(events).toContain('run.completed');
    await agent.close();
  });

  it('uses diffNewMessages as a fallback when adapter omits newMessages', async () => {
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: new EchoAdapter(),
    });

    const result = await agent.run('hi');

    expect(result.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'hello',
    });
    expect(result.finishReason).toBe('stop');
    await agent.close();
  });

  it('honors memory retrieve policies', async () => {
    let oncePerRun = 0;
    let oncePerTurn = 0;
    const adapter: ModelAdapter = {
      async generate(request) {
        const first = !request.messages.some(
          (message) => message.role === 'assistant',
        );
        return {
          text: first ? '' : 'done',
          messages: [
            ...request.messages,
            { role: 'assistant', content: first ? 'tool result' : 'done' },
          ],
          newMessages: [
            { role: 'assistant', content: first ? 'tool result' : 'done' },
          ],
          usage: {
            requests: 1,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            toolCalls: 0,
          },
          finishReason: first ? 'tool-calls' : 'stop',
          provider: null,
        };
      },
      async *stream(request) {
        yield { type: 'final', response: await this.generate(request) };
      },
    };
    const runAgent = createAgent({
      model: 'test:model',
      modelAdapter: adapter,
      memory: {
        retrievePolicy: 'once-per-run',
        retrieve: () => {
          oncePerRun += 1;
          return [];
        },
      },
    });
    const turnAgent = createAgent({
      model: 'test:model',
      modelAdapter: adapter,
      memory: {
        retrievePolicy: 'once-per-turn',
        retrieve: () => {
          oncePerTurn += 1;
          return [];
        },
      },
    });

    await runAgent.run('hi');
    await turnAgent.run('hi');

    expect(oncePerRun).toBe(1);
    expect(oncePerTurn).toBe(2);
    await runAgent.close();
    await turnAgent.close();
  });

  it('stream abort resolves final as interrupted instead of failing', async () => {
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: new EchoAdapter(),
    });

    const stream = agent.stream('hi');
    stream.abort('stop now');
    const result = await stream.final;

    expect(result.finishReason).toBe('interrupted');
    expect(result.pending?.[0]).toMatchObject({ kind: 'interrupted' });
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
