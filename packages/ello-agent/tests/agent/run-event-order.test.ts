/**
 * 本文件验证产品 Agent run 按模型轮次提交文本，并保留文本与工具调用的发生顺序。
 *
 * 测试运行真实 engine loop，只替换模型 adapter 与无副作用工具，避免用手工事件掩盖生命周期错误。
 */
import { describe, expect, it } from 'vitest';

import type {
  AgentRunEvent,
  BuiltAgent,
} from '../../src/features/agent/contracts.js';
import {
  createAgent,
  defineTool,
  z,
  type AgentMessage,
  type AgentModelRequest,
  type AgentModelResponse,
} from '../../src/features/agent/engine/index.js';
import { startAgentRun } from '../../src/features/agent/run.js';

describe('Agent run event ordering', () => {
  it('commits each model message before the tools requested by that model call', async () => {
    let modelCalls = 0;
    const inspect = defineTool({
      name: 'inspect',
      description: 'Inspect one step.',
      discovery: { aliases: [], risk: 'readonly' },
      input: z.object({ step: z.number().int() }).strict(),
      execute: ({ step }) => ({ inspected: step }),
    });
    const engine = createAgent({
      model: 'test:model',
      modelCall: {
        agentName: 'test-agent',
        modelSelector: 'primary_model',
        configuredModel: 'test-model',
        protocol: 'openai',
        apiModel: 'model',
      },
      modelAdapter: {
        async generate(request) {
          modelCalls += 1;
          return responseForCall(request, modelCalls);
        },
        async *stream(request) {
          const call = modelCalls + 1;
          yield {
            type: 'text-delta',
            text: call <= 2 ? `before tool ${call}` : 'done',
          };
          yield { type: 'final', response: await this.generate(request) };
        },
      },
      environment: {},
      executionTools: [inspect],
      modelTools: [inspect],
    });
    const built: BuiltAgent = {
      engine,
      maxTurns: undefined,
      modelCompactor: () => undefined,
      setMode: () => undefined,
      close: () => engine.close(),
    };
    const run = startAgentRun(built, {
      threadId: 'thread-order',
      turnId: 'turn-order',
      cwd: '/workspace',
      selection: { mode: 'ask-before-changes', agent: 'test-agent' },
      history: [],
      input: 'inspect twice',
      goal: null,
      permission: { rules: () => [], externalPaths: () => [] },
    });
    const events: AgentRunEvent[] = [];

    for await (const event of run.events) events.push(event);
    await expect(run.result).resolves.toMatchObject({ status: 'completed' });

    expect(events.flatMap(orderingLabel)).toEqual([
      'message:before tool 1',
      'tool:start:call-1',
      'tool:complete:call-1',
      'message:before tool 2',
      'tool:start:call-2',
      'tool:complete:call-2',
      'message:done',
    ]);
  });

  it('publishes a correlated event only when the engine consumes steering', async () => {
    const firstModelStarted = deferred<void>();
    const releaseFirstModel = deferred<void>();
    let modelCalls = 0;
    let secondRequest: AgentModelRequest | undefined;
    const inspect = defineTool({
      name: 'inspect',
      description: 'Inspect one step.',
      discovery: { aliases: [], risk: 'readonly' },
      input: z.object({}).strict(),
      execute: () => ({ inspected: true }),
    });
    const engine = createAgent({
      model: 'test:model',
      modelCall: {
        agentName: 'test-agent',
        modelSelector: 'primary_model',
        configuredModel: 'test-model',
        protocol: 'openai',
        apiModel: 'model',
      },
      modelAdapter: {
        generate: async () => {
          throw new Error('Streaming adapter should not call generate.');
        },
        async *stream(request) {
          modelCalls += 1;
          if (modelCalls === 1) {
            firstModelStarted.resolve();
            await releaseFirstModel.promise;
            yield { type: 'final', response: toolResponse(request) };
            return;
          }
          secondRequest = request;
          yield { type: 'final', response: finalResponse(request) };
        },
      },
      environment: {},
      executionTools: [inspect],
      modelTools: [inspect],
    });
    const built: BuiltAgent = {
      engine,
      maxTurns: undefined,
      modelCompactor: () => undefined,
      setMode: () => undefined,
      close: () => engine.close(),
    };
    const run = startAgentRun(built, {
      threadId: 'thread-steer',
      turnId: 'turn-steer',
      cwd: '/workspace',
      selection: { mode: 'ask-before-changes', agent: 'test-agent' },
      history: [],
      input: 'inspect once',
      goal: null,
      permission: { rules: () => [], externalPaths: () => [] },
    });
    const events: AgentRunEvent[] = [];
    const collectEvents = (async () => {
      for await (const event of run.events) events.push(event);
    })();

    await firstModelStarted.promise;
    run.steer('steer_focus', 'focus tests');
    run.notify(
      'notification_background',
      '<task-notification>background done</task-notification>',
    );
    expect(events.some((event) => event.type === 'steeringConsumed')).toBe(
      false,
    );
    releaseFirstModel.resolve();
    await collectEvents;
    await expect(run.result).resolves.toMatchObject({ status: 'completed' });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'steeringConsumed',
        steerId: 'steer_focus',
        text: 'focus tests',
      }),
    );
    expect(secondRequest?.messages).toContainEqual({
      role: 'user',
      content: 'focus tests',
    });
    expect(secondRequest?.messages).toContainEqual({
      role: 'user',
      content: '<task-notification>background done</task-notification>',
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'steeringConsumed',
        steerId: 'notification_background',
      }),
    );
  });

  it('continues the same run when a background task finishes after a natural answer', async () => {
    const notification = deferred<string | undefined>();
    const requests: AgentModelRequest[] = [];
    const inspect = defineTool({
      name: 'inspect',
      description: 'Inspect one step.',
      discovery: { aliases: [], risk: 'readonly' },
      input: z.object({}).strict(),
      execute: () => ({ inspected: true }),
    });
    const engine = createAgent({
      model: 'test:model',
      modelCall: {
        agentName: 'test-agent',
        modelSelector: 'primary_model',
        configuredModel: 'test-model',
        protocol: 'openai',
        apiModel: 'model',
      },
      modelAdapter: {
        generate: async () => {
          throw new Error('Streaming adapter should not call generate.');
        },
        async *stream(request) {
          requests.push(request);
          const text = requests.length === 1 ? 'waiting' : 'synthesized';
          yield {
            type: 'final',
            response: finalResponseWithText(request, text),
          };
        },
      },
      environment: {},
      executionTools: [inspect],
      modelTools: [inspect],
    });
    let notificationWaits = 0;
    const built: BuiltAgent = {
      engine,
      maxTurns: undefined,
      waitForTaskNotification: () =>
        notificationWaits++ === 0
          ? notification.promise
          : Promise.resolve(undefined),
      modelCompactor: () => undefined,
      setMode: () => undefined,
      close: () => engine.close(),
    };
    const run = startAgentRun(built, {
      threadId: 'thread-background',
      turnId: 'turn-background',
      cwd: '/workspace',
      selection: { mode: 'ask-before-changes', agent: 'test-agent' },
      history: [],
      input: 'delegate in background',
      goal: null,
      permission: { rules: () => [], externalPaths: () => [] },
    });
    const events: AgentRunEvent[] = [];
    const collectEvents = (async () => {
      for await (const event of run.events) events.push(event);
    })();

    await expect.poll(() => requests.length).toBe(1);
    let settled = false;
    void run.result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    notification.resolve('<task-notification>done</task-notification>');
    await collectEvents;
    await expect(run.result).resolves.toMatchObject({ status: 'completed' });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toContainEqual({
      role: 'user',
      content: '<task-notification>done</task-notification>',
    });
    expect(
      events
        .filter((event) => event.type === 'messageCompleted')
        .map((event) => event.text),
    ).toEqual(['waiting', 'synthesized']);
  });

  it('accepts user steering while waiting for a background task notification', async () => {
    const waitingNotification = deferred<string | undefined>();
    const requests: AgentModelRequest[] = [];
    const inspect = defineTool({
      name: 'inspect',
      description: 'Inspect one step.',
      discovery: { aliases: [], risk: 'readonly' },
      input: z.object({}).strict(),
      execute: () => ({ inspected: true }),
    });
    const engine = createAgent({
      model: 'test:model',
      modelCall: {
        agentName: 'test-agent',
        modelSelector: 'primary_model',
        configuredModel: 'test-model',
        protocol: 'openai',
        apiModel: 'model',
      },
      modelAdapter: {
        generate: async () => {
          throw new Error('Streaming adapter should not call generate.');
        },
        async *stream(request) {
          requests.push(request);
          yield {
            type: 'final',
            response: finalResponseWithText(
              request,
              requests.length === 1 ? 'waiting' : 'steered response',
            ),
          };
        },
      },
      environment: {},
      executionTools: [inspect],
      modelTools: [inspect],
    });
    let notificationWaits = 0;
    const built: BuiltAgent = {
      engine,
      maxTurns: undefined,
      waitForTaskNotification: () =>
        notificationWaits++ === 0
          ? waitingNotification.promise
          : Promise.resolve(undefined),
      modelCompactor: () => undefined,
      setMode: () => undefined,
      close: () => engine.close(),
    };
    const run = startAgentRun(built, {
      threadId: 'thread-waiting-steer',
      turnId: 'turn-waiting-steer',
      cwd: '/workspace',
      selection: { mode: 'ask-before-changes', agent: 'test-agent' },
      history: [],
      input: 'delegate in background',
      goal: null,
      permission: { rules: () => [], externalPaths: () => [] },
    });
    const events: AgentRunEvent[] = [];
    const collectEvents = (async () => {
      for await (const event of run.events) events.push(event);
    })();

    await expect.poll(() => requests.length).toBe(1);
    run.steer('steer_follow_up', 'also inspect the TUI');
    await collectEvents;
    await expect(run.result).resolves.toMatchObject({ status: 'completed' });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toContainEqual({
      role: 'user',
      content: 'also inspect the TUI',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'steeringConsumed',
        steerId: 'steer_follow_up',
        text: 'also inspect the TUI',
      }),
    );
  });

  it('fails when maxTurns is reached before a final answer', async () => {
    const inspect = defineTool({
      name: 'inspect',
      description: 'Inspect one step.',
      discovery: { aliases: [], risk: 'readonly' },
      input: z.object({}).strict(),
      execute: () => ({ inspected: true }),
    });
    const engine = createAgent({
      model: 'test:model',
      modelCall: {
        agentName: 'test-agent',
        modelSelector: 'primary_model',
        configuredModel: 'test-model',
        protocol: 'openai',
        apiModel: 'model',
      },
      modelAdapter: {
        generate: (request) => Promise.resolve(toolResponse(request)),
        async *stream(request) {
          yield { type: 'final', response: await this.generate(request) };
        },
      },
      environment: {},
      executionTools: [inspect],
      modelTools: [inspect],
    });
    const built: BuiltAgent = {
      engine,
      maxTurns: 1,
      modelCompactor: () => undefined,
      setMode: () => undefined,
      close: () => engine.close(),
    };
    const run = startAgentRun(built, {
      threadId: 'thread-max-turns',
      turnId: 'turn-max-turns',
      cwd: '/workspace',
      selection: { mode: 'ask-before-changes', agent: 'test-agent' },
      history: [],
      input: 'inspect once',
      goal: null,
      permission: { rules: () => [], externalPaths: () => [] },
    });
    const collectEvents = (async () => {
      for await (const _event of run.events) {
        // Drain the event stream so the run can close normally.
      }
    })();

    await expect(run.result).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'AGENT_RUN_FAILED',
        message: 'Agent reached max turns without a final answer.',
      },
    });
    await collectEvents;
  });
});

function toolResponse(request: AgentModelRequest): AgentModelResponse {
  const message: AgentMessage = {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call-steer',
        toolName: 'inspect',
        input: {},
      },
    ],
  };
  return {
    text: '',
    messages: [...request.messages, message],
    newMessages: [message],
    toolCalls: [{ id: 'call-steer', name: 'inspect', input: {} }],
    usage: testUsage(),
    finishReason: 'tool-calls',
    provider: null,
  };
}

function finalResponse(request: AgentModelRequest): AgentModelResponse {
  return finalResponseWithText(request, 'done');
}

function finalResponseWithText(
  request: AgentModelRequest,
  text: string,
): AgentModelResponse {
  const message: AgentMessage = { role: 'assistant', content: text };
  return {
    text,
    messages: [...request.messages, message],
    newMessages: [message],
    usage: testUsage(),
    finishReason: 'stop',
    provider: null,
  };
}

function testUsage() {
  return {
    requests: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function responseForCall(
  request: AgentModelRequest,
  call: number,
): AgentModelResponse {
  const usage = {
    requests: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: call <= 2 ? 1 : 0,
  };
  if (call > 2) {
    const message: AgentMessage = { role: 'assistant', content: 'done' };
    return {
      text: 'done',
      messages: [...request.messages, message],
      newMessages: [message],
      usage,
      finishReason: 'stop',
      provider: null,
    };
  }
  const id = `call-${call}`;
  const message: AgentMessage = {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: 'inspect',
        input: { step: call },
      },
    ],
  };
  return {
    text: `before tool ${call}`,
    messages: [...request.messages, message],
    newMessages: [message],
    toolCalls: [{ id, name: 'inspect', input: { step: call } }],
    usage,
    finishReason: 'tool-calls',
    provider: null,
  };
}

function orderingLabel(event: AgentRunEvent): string[] {
  switch (event.type) {
    case 'messageCompleted':
      return [`message:${event.text}`];
    case 'toolStarted':
      return [`tool:start:${event.toolCallId}`];
    case 'toolCompleted':
      return [`tool:complete:${event.toolCallId}`];
    default:
      return [];
  }
}
