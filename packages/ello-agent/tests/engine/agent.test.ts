/**
 * 本文件验证 agent 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentStreamBackpressureError,
  ModelAdapterProtocolError,
  createAgent as createBaseAgent,
  defineDeferredTool,
  defineTool as defineAgentTool,
  z,
  type AgentModelEvent,
  type AgentMessage,
  type AgentModelRequest,
  type AgentModelResponse,
  type EngineEvent,
  type AnyAgentTool,
  type CreateAgentOptions,
  type DefineToolOptions,
  type AgentToolDiscovery,
  type ModelAdapter,
} from '../../src/features/agent/engine/index.js';
import { trimMessages } from '../../src/features/agent/engine/model-input.js';
import {
  AgentRunControl,
  DefaultAgentMessageQueue,
} from '../../src/features/agent/engine/run-control.js';
import { createLocalEnvironment } from '../../src/features/agent/environment.js';

function defineTool<TInput, TOutput>(
  options: Omit<DefineToolOptions<TInput, TOutput>, 'discovery'> & {
    readonly discovery?: AgentToolDiscovery;
  },
) {
  const { discovery, ...tool } = options;
  return defineAgentTool({
    ...tool,
    discovery: discovery ?? { aliases: [], risk: 'readonly' },
  });
}

const testTool = defineTool({
  name: 'test_noop',
  description: 'No-op tool for agent loop tests.',
  discovery: { aliases: ['noop'], risk: 'readonly' },
  input: z.object({}).strict(),
  execute: () => null,
});

const emptyTestEnvironment: CreateAgentOptions['environment'] = {};

function createAgent(
  options: Omit<
    CreateAgentOptions,
    'executionTools' | 'modelTools' | 'environment'
  > & {
    readonly tools?: readonly AnyAgentTool[];
    readonly executionTools?: readonly AnyAgentTool[];
    readonly modelTools?: readonly AnyAgentTool[];
    readonly environment?: CreateAgentOptions['environment'];
  },
) {
  const { tools, executionTools, modelTools, environment, ...rest } = options;
  const selected = tools ?? executionTools ?? [testTool as AnyAgentTool];
  return createBaseAgent({
    ...rest,
    environment: environment === undefined ? emptyTestEnvironment : environment,
    executionTools: executionTools ?? selected,
    modelTools: modelTools ?? selected,
  });
}

class EchoAdapter implements ModelAdapter {
  async generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    return {
      text: 'hello',
      messages: [...request.messages, { role: 'assistant', content: 'hello' }],
      newMessages: [{ role: 'assistant', content: 'hello' }],
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
    const events: EngineEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const final = await stream.final;

    expect(result.output).toBe('hello');
    expect(final.output).toBe('hello');
    expect(events.some((event) => event.type === 'message.delta')).toBe(true);
    const completed = events.find((event) => event.type === 'run.completed');
    expect(completed).toMatchObject({
      runId: final.id,
      finishReason: final.finishReason,
      usage: final.usage,
    });
    expect(completed).not.toHaveProperty('result');
    await agent.close();
  });

  it('adds ephemeral run instructions to system without persisting them', async () => {
    let request: AgentModelRequest | undefined;
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: {
        async generate(input) {
          request = input;
          return {
            text: 'done',
            messages: [
              ...input.messages,
              { role: 'assistant', content: 'done' },
            ],
            newMessages: [{ role: 'assistant', content: 'done' }],
            usage: {
              requests: 1,
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              toolCalls: 0,
            },
            finishReason: 'stop',
            provider: {},
          };
        },
        async *stream(input) {
          yield { type: 'final', response: await this.generate(input) };
        },
      },
    });
    const result = await agent.run('task', {
      ephemeralInstructions: 'temporary skill instructions',
    });
    expect(request?.system).toBe('temporary skill instructions');
    expect(request?.messages).not.toContainEqual(
      expect.objectContaining({ role: 'system' }),
    );
    expect(result.newMessages).not.toContainEqual({
      role: 'system',
      content: 'temporary skill instructions',
    });
    await agent.close();
  });

  it('fails when adapter stream ends without final and does not call generate', async () => {
    let generateCalls = 0;
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: {
        async generate(request) {
          generateCalls += 1;
          return new EchoAdapter().generate(request);
        },
        async *stream() {
          yield { type: 'text-delta', text: 'partial' } as const;
        },
      },
    });

    await expect(agent.run('hi')).rejects.toBeInstanceOf(
      ModelAdapterProtocolError,
    );
    expect(generateCalls).toBe(0);
    await agent.close();
  });

  it('fails when adapter emits more than one final', async () => {
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: {
        generate: (request) => new EchoAdapter().generate(request),
        async *stream(request) {
          const response = await new EchoAdapter().generate(request);
          yield { type: 'final', response } as const;
          yield { type: 'final', response } as const;
        },
      },
    });

    await expect(agent.run('hi')).rejects.toThrow(
      'Model adapter emitted more than one final event.',
    );
    await agent.close();
  });

  it('fails when adapter emits a delta after final', async () => {
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: {
        generate: (request) => new EchoAdapter().generate(request),
        async *stream(request) {
          yield {
            type: 'final',
            response: await new EchoAdapter().generate(request),
          } as const;
          yield { type: 'text-delta', text: 'late' } as const;
        },
      },
    });

    await expect(agent.run('hi')).rejects.toThrow(
      'Model adapter emitted an event after the final event.',
    );
    await agent.close();
  });

  it('preserves provider errors without generating an empty result', async () => {
    const providerError = new Error('provider request failed');
    let generateCalls = 0;
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: {
        async generate(request) {
          generateCalls += 1;
          return new EchoAdapter().generate(request);
        },
        stream() {
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () => Promise.reject(providerError),
              };
            },
          };
        },
      },
    });

    await expect(agent.run('hi')).rejects.toBe(providerError);
    expect(generateCalls).toBe(0);
    await agent.close();
  });

  it('fails a stream when an unconsumed event buffer reaches its limit', async () => {
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: new EchoAdapter(),
      stream: { maxBufferedEvents: 2 },
    });

    const stream = agent.stream('hi');
    await expect(stream.final).rejects.toBeInstanceOf(
      AgentStreamBackpressureError,
    );
    await agent.close();
  });

  it('flushes the explicit event recorder before resolving final', async () => {
    const recorded: string[] = [];
    let flushed = false;
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: new EchoAdapter(),
      eventRecorder: {
        record: (event) => {
          recorded.push(event.type);
        },
        flush: () => {
          flushed = true;
        },
      },
    });

    await agent.run('hi');
    expect(recorded).toContain('run.completed');
    expect(flushed).toBe(true);
    await agent.close();
  });

  it('fails the run when the event recorder fails', async () => {
    const recorderError = new Error('recorder write failed');
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: new EchoAdapter(),
      eventRecorder: {
        record: (event) => {
          if (event.type === 'run.completed') {
            throw recorderError;
          }
        },
      },
    });

    await expect(agent.run('hi')).rejects.toBe(recorderError);
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

  it('按工具名稳定发送 toolset，并拒绝重复名称', async () => {
    const seen: string[][] = [];
    const adapter: ModelAdapter = {
      generate: (request) => new EchoAdapter().generate(request),
      async *stream(request) {
        seen.push(Object.keys(request.tools));
        yield { type: 'final', response: await this.generate(request) };
      },
    };
    const makeTool = (name: string) =>
      defineTool({
        name,
        description: name,
        input: z.object({}),
        execute: () => name,
      });
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: adapter,
      tools: [makeTool('zeta'), makeTool('alpha')],
    });

    await agent.run('hi');
    expect(seen).toEqual([['alpha', 'zeta']]);
    await agent.close();

    expect(() =>
      createAgent({
        model: 'test:model',
        modelAdapter: adapter,
        tools: [makeTool('same'), makeTool('same')],
      }),
    ).toThrow("Duplicate tool 'same' in executionTools.");
  });

  it('uses local environment and returns the current run messages', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ello-agent-'));
    dirs.push(dir);
    const environment = createLocalEnvironment({
      cwd: dir,
      allowedPaths: [dir],
    });
    await environment.fileSystem?.writeText('note.txt', 'content');
    const entries = await environment.fileSystem?.listDir('.');
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: new EchoAdapter(),
      environment,
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
    const result = await agent.run('remember');

    expect(entries).toContain('note.txt');
    expect(result.newMessages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    await agent.close();
  });

  it('passes the complete current messages to the pure compactor', async () => {
    let messagesSeenByCompactor: AgentMessage[] = [];
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: new EchoAdapter(),
      modelInputBudget: { maxInputTokens: 100 },
      compactor: {
        name: 'test-compactor',
        async compact(input) {
          messagesSeenByCompactor = [...input.messages];
          return {
            messages: input.messages,
            report: {
              compactor: 'test-compactor',
              beforeMessageCount: input.messages.length,
              afterMessageCount: input.messages.length,
              summary: 'summary',
              keptMessageCount: input.messages.length,
              tokensBefore: 2,
            },
          };
        },
      },
    });

    const result = await agent.run('current input');

    expect(messagesSeenByCompactor.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(result.diagnostics?.compactions).toEqual([
      expect.objectContaining({ compactor: 'test-compactor' }),
    ]);
    await agent.close();
  });

  it('runs environment lifecycle and resource instructions inside the agent loop', async () => {
    const events: string[] = [];
    const requests: AgentModelRequest[] = [];
    const environment = createLocalEnvironment({
      cwd: process.cwd(),
      allowedPaths: [process.cwd()],
    });
    environment.resources?.register('test-resource', {
      setup: () => {
        events.push('resource.setup');
      },
      getContextInstructions: () => 'Resource instruction.',
      close: () => {
        events.push('resource.close');
      },
    });
    const originalSetup = environment.setup?.bind(environment);
    const originalClose = environment.close?.bind(environment);
    environment.setup = async (ctx) => {
      events.push(`setup:${ctx.runId.length > 0}`);
      await originalSetup?.(ctx);
    };
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
      observers: [
        {
          onRunStarted: () => {
            events.push('run.started');
          },
          onRunCompleted: () => {
            events.push('run.completed');
          },
        },
      ],
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

  it('resumes approvals by appending a tool-result after persisted tool-call history', () => {
    const control = new AgentRunControl('run_approval');
    control.sessionQueue.push({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_write',
          toolName: 'write',
          input: { path: 'tmp', content: 'abc' },
        },
      ],
    } as never);

    const drained = control.drainNextTurn({
      deferred: [
        {
          kind: 'approval',
          toolCallId: 'call_write',
          toolName: 'write',
          input: { path: 'tmp', content: 'abc' },
        },
      ],
      approvals: { call_write: { approved: true } },
      toolResults: { call_write: { path: 'tmp', written: true } },
    });

    expect(drained.messages).toHaveLength(2);
    expect(drained.messages[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call_write' }],
    });
    expect(drained.messages[1]).toMatchObject({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_write',
          toolName: 'write',
          output: {
            type: 'json',
            value: { path: 'tmp', written: true },
          },
        },
      ],
    });
  });

  it('rejects deferred approval items without a tool name', () => {
    const control = new AgentRunControl('run_invalid_approval');

    expect(() =>
      Reflect.apply(control.drainNextTurn, control, [
        {
          deferred: [{ kind: 'approval', toolCallId: 'call_write', input: {} }],
          approvals: { call_write: true },
          toolResults: { call_write: { written: true } },
        },
      ]),
    ).toThrow();
  });

  it('rejects structured approval decisions without approved', () => {
    const control = new AgentRunControl('run_invalid_decision');

    expect(() =>
      Reflect.apply(control.drainNextTurn, control, [
        {
          deferred: [
            {
              kind: 'approval',
              toolCallId: 'call_write',
              toolName: 'write',
              input: {},
            },
          ],
          approvals: { call_write: { reason: 'missing decision' } },
        },
      ]),
    ).toThrow();
  });

  it('rejects interrupted resume items without messages', () => {
    const control = new AgentRunControl('run_invalid_interrupted');

    expect(() =>
      Reflect.apply(control.drainNextTurn, control, [
        { deferred: [{ kind: 'interrupted', reason: 'cancelled' }] },
      ]),
    ).toThrow();
  });

  it('builds model input with explicit history, observers, and transforms', async () => {
    const seenMessages: AgentModelRequest[] = [];
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
      modelInput: {
        systemSections: [() => 'Working directory: /tmp/project'],
        messageTransforms: [trimMessages({ maxMessages: 3 })],
        providerOptions: () => ({ test: { enabled: true } }),
      },
      observers: [
        {
          onTurnStarted: () => {
            observed.push('turn-started');
          },
          onRunCompleted: () => {
            observed.push('run.completed');
          },
        },
      ],
    });
    const result = await agent.run({
      messages: [{ role: 'user', content: 'history' }],
      prompt: 'current',
    });

    expect(seenMessages[0]?.system).toContain('Be precise.');
    expect(seenMessages[0]?.system).toContain(
      'Working directory: /tmp/project',
    );
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

  it('resumes approved tools against explicit history without missing tool results', async () => {
    const requests: AgentModelRequest[] = [];
    const persistedToolCall = {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_write',
          toolName: 'write_file',
          input: { path: 'tmp', content: 'abc' },
        },
      ],
    } as AgentMessage;
    const agent = createAgent({
      model: 'test:model',
      tools: [
        defineTool({
          name: 'write_file',
          description: 'Write a file',
          input: z.object({ path: z.string(), content: z.string() }),
          approval: () => 'required',
          execute: ({ path, content }) => ({ path, content }),
        }),
      ],
      modelAdapter: {
        async generate(request) {
          requests.push(request);
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
              outputTokens: 1,
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

    const stream = agent.resume({
      messages: [persistedToolCall],
      deferred: {
        deferred: [
          {
            kind: 'approval',
            toolCallId: 'call_write',
            toolName: 'write_file',
            input: { path: 'tmp', content: 'abc' },
          },
        ],
        approvals: { call_write: { approved: true } },
      },
    });
    for await (const _event of stream) {
      // drive stream
    }
    const result = await stream.final;

    expect(result.output).toBe('done');
    expect(requests).toHaveLength(1);
    const requestMessages = requests[0]?.messages ?? [];
    const assistantToolCalls = requestMessages.filter(
      (message) =>
        message.role === 'assistant' &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            typeof part === 'object' &&
            part !== null &&
            (part as { toolCallId?: string }).toolCallId === 'call_write',
        ),
    );
    const toolResults = requestMessages.filter(
      (message) =>
        message.role === 'tool' &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            typeof part === 'object' &&
            part !== null &&
            (part as { toolCallId?: string }).toolCallId === 'call_write',
        ),
    );
    expect(assistantToolCalls).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    expect(result.newMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          content: expect.arrayContaining([
            expect.objectContaining({ toolCallId: 'call_write' }),
          ]),
        }),
      ]),
    );
    await agent.close();
  });

  it('continues the loop after tool-calls and builds input once per turn', async () => {
    const requests: AgentModelRequest[] = [];
    const observed: string[] = [];
    const agent = createAgent({
      model: 'test:model',
      observers: [
        {
          onTurnStarted: () => {
            observed.push('turn-started');
          },
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

  it('injects stream steering into the next turn', async () => {
    const requests: AgentModelRequest[] = [];
    const agent = createAgent({
      model: 'test:model',
      modelAdapter: {
        async generate(request) {
          requests.push(request);
          const first = requests.length === 1;
          return {
            text: first ? '' : 'done',
            messages: [
              ...request.messages,
              { role: 'assistant', content: first ? 'thinking' : 'done' },
            ],
            newMessages: [
              { role: 'assistant', content: first ? 'thinking' : 'done' },
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
      },
    });

    const stream = agent.stream('start');
    stream.steer({ role: 'user', content: 'please adjust' });
    for await (const _event of stream) {
      // drive stream
    }
    await stream.final;

    expect(requests).toHaveLength(2);
    expect(
      requests[1]?.messages.some(
        (message) =>
          message.role === 'user' && message.content === 'please adjust',
      ),
    ).toBe(true);
    await agent.close();
  });

  it('uses explicit history once and does not duplicate it on the second turn', async () => {
    const seen = [] as string[][];
    const agent = createAgent({
      model: 'test:model',
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

    await agent.run({
      messages: [{ role: 'user', content: 'history' }],
      prompt: 'current',
    });

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

  it('uses the adapter-declared new messages', async () => {
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

  it('carries tool-call and tool-result messages into the next turn', async () => {
    const seen: AgentModelRequest[] = [];
    const agent = createAgent({
      model: 'test:model',
      tools: [
        defineTool({
          name: 'write',
          description: 'Write a file',
          input: z.object({ path: z.string(), content: z.string() }),
          execute: ({ path: targetPath, content }) => ({
            path: targetPath,
            content,
          }),
        }),
      ],
      modelAdapter: {
        async generate(request) {
          seen.push(request);
          if (seen.length === 1) {
            return {
              text: '',
              messages: [
                ...request.messages,
                {
                  role: 'assistant',
                  content: [
                    {
                      type: 'tool-call',
                      toolCallId: 'call_1',
                      toolName: 'write',
                      input: { path: 'tmp', content: 'abc' },
                    },
                  ],
                } as never,
              ],
              newMessages: [
                {
                  role: 'assistant',
                  content: [
                    {
                      type: 'tool-call',
                      toolCallId: 'call_1',
                      toolName: 'write',
                      input: { path: 'tmp', content: 'abc' },
                    },
                  ],
                } as never,
              ],
              toolCalls: [
                {
                  id: 'call_1',
                  name: 'write',
                  input: { path: 'tmp', content: 'abc' },
                },
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

    const result = await agent.run('write tmp');
    const secondTurn = JSON.stringify(seen[1]?.messages);

    expect(result.output).toBe('done');
    expect(seen).toHaveLength(2);
    expect(secondTurn).toContain('"type":"tool-call"');
    expect(secondTurn).toContain('"type":"tool-result"');
    expect(secondTurn).toContain('call_1');
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

  it('stops for a deferred tool and resumes with the matching result', async () => {
    let modelCalls = 0;
    const deferredTool = defineDeferredTool({
      name: 'ask',
      description: 'Ask the host',
      discovery: { aliases: [], risk: 'readonly' },
      input: z.object({ question: z.string() }).strict(),
    });
    const agent = createAgent({
      model: 'test:model',
      tools: [deferredTool],
      modelAdapter: {
        async generate(request) {
          modelCalls += 1;
          if (modelCalls === 1) {
            const assistant = {
              role: 'assistant' as const,
              content: [
                {
                  type: 'tool-call' as const,
                  toolCallId: 'ask-1',
                  toolName: 'ask',
                  input: { question: 'Choose?' },
                },
              ],
            };
            return {
              text: '',
              messages: [...request.messages, assistant],
              newMessages: [assistant],
              toolCalls: [
                { id: 'ask-1', name: 'ask', input: { question: 'Choose?' } },
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
          }
          expect(JSON.stringify(request.messages)).toContain('selected');
          return new EchoAdapter().generate(request);
        },
        async *stream(request) {
          yield { type: 'final', response: await this.generate(request) };
        },
      },
    });
    const pending = await agent.run('ask');
    expect(pending.finishReason).toBe('tool-result-required');
    expect(pending.pending).toEqual([
      expect.objectContaining({ kind: 'tool-call', toolCallId: 'ask-1' }),
    ]);
    const deferred = pending.pending;

    const stream = agent.resume({
      messages: pending.messages,
      deferred: {
        deferred,
        toolResults: { 'ask-1': { selected: 'A' } },
      },
    });
    for await (const _event of stream) {
      // consume
    }
    expect((await stream.final).output).toBe('hello');

    const invalid = agent.resume({
      messages: pending.messages,
      deferred: {
        deferred,
        toolResults: { wrong: 'answer' },
      },
    });
    await expect(async () => {
      for await (const _event of invalid) {
        // consume
      }
    }).rejects.toThrow('unknown tool calls');
    await agent.close();
  });

  it('resume denial emits a terminal tool failure without executing', async () => {
    let executions = 0;
    const agent = createAgent({
      model: 'test:model',
      tools: [
        defineTool({
          name: 'danger',
          description: 'Dangerous tool',
          input: z.object({ value: z.string() }),
          execute: () => {
            executions += 1;
            return 'unexpected';
          },
        }),
      ],
      modelAdapter: new EchoAdapter(),
    });
    const stream = agent.stream([], {
      resume: {
        deferred: [
          {
            kind: 'approval',
            toolCallId: 'call_denied',
            toolName: 'danger',
            input: { value: 'x' },
          },
        ],
        approvals: {
          call_denied: { approved: false, reason: 'Denied by user' },
        },
      },
    });
    const events: EngineEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.final;

    expect(executions).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'call_denied',
        error: expect.objectContaining({ message: 'Denied by user' }),
      }),
    );
    await agent.close();
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
