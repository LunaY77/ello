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
  z,
  type AgentMessage,
  type AgentModelRequest,
  type AgentModelResponse,
} from '../../src/features/agent/engine/index.js';
import { startAgentRun } from '../../src/features/agent/run.js';
import { createTestCommandRun, defineTestCommand } from '../support/command.js';
import { createTestEnvironmentHandle } from '../support/environment.js';

describe('Agent run event ordering', () => {
  it('commits each model message before the tools requested by that model call', async () => {
    let modelCalls = 0;
    const inspect = defineTestCommand({
      name: 'inspect',
      summary: 'Inspect one step.',
      schema: z.object({ step: z.number().int() }).strict(),
      run: ({ step }) => ({ inspected: step }),
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
      environment: createTestEnvironmentHandle(),
      commandRun: createTestCommandRun([inspect]),
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
      executionLocation: {
        environmentRef: 'test',
        workingDirectory: '/workspace',
      },
      selection: { mode: 'ask-before-changes', agent: 'test-agent' },
      history: [],
      input: 'inspect twice',
      goal: null,
      permission: { rules: () => [], externalPaths: () => [] },
    });
    const events: AgentRunEvent[] = [];

    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'contextCompacted') {
        run.acknowledgeCompaction(event.compactionId);
      }
    }
    await expect(run.result).resolves.toMatchObject({ status: 'completed' });

    expect(events.flatMap(orderingLabel)).toEqual([
      'message:before tool 1',
      'command:start:command-run:call-1:0',
      'command:complete:command-run:call-1:0',
      'message:before tool 2',
      'command:start:command-run:call-2:0',
      'command:complete:command-run:call-2:0',
      'message:done',
    ]);
  });

  it('publishes a completed Context Checkpoint before the next model message', async () => {
    const inspect = defineTestCommand({
      name: 'inspect',
      summary: 'Inspect one step.',
      schema: z.object({}).strict(),
      run: () => ({ inspected: true }),
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
          throw new Error('This compactor does not require a model call.');
        },
        async *stream(request) {
          yield { type: 'text-delta', text: 'after checkpoint' };
          yield {
            type: 'final',
            response: finalResponseWithText(request, 'after checkpoint'),
          };
        },
      },
      environment: createTestEnvironmentHandle(),
      commandRun: createTestCommandRun([inspect]),
      modelInputBudget: { maxInputTokens: 1_000 },
      compactor: {
        name: 'test-compactor',
        async compact(input) {
          return {
            messages: input.messages,
            report: {
              compactor: 'test-compactor',
              beforeMessageCount: input.messages.length,
              afterMessageCount: input.messages.length,
              summary: 'checkpoint',
              keptMessageCount: input.messages.length,
              tokensBefore: 2,
            },
          };
        },
      },
    });
    const built: BuiltAgent = {
      engine,
      maxTurns: undefined,
      modelCompactor: () => undefined,
      setMode: () => undefined,
      close: () => engine.close(),
    };
    const run = startAgentRun(built, {
      threadId: 'thread-checkpoint-order',
      turnId: 'turn-checkpoint-order',
      executionLocation: {
        environmentRef: 'test',
        workingDirectory: '/workspace',
      },
      selection: { mode: 'ask-before-changes', agent: 'test-agent' },
      history: [],
      input: 'continue after compaction',
      goal: null,
      permission: { rules: () => [], externalPaths: () => [] },
    });
    const events: AgentRunEvent[] = [];

    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'contextCompacted') {
        run.acknowledgeCompaction(event.compactionId);
      }
    }
    await expect(run.result).resolves.toMatchObject({ status: 'completed' });

    const started = events.findIndex(
      (event) => event.type === 'contextCompactionStarted',
    );
    const inputCommitted = events.findIndex(
      (event) =>
        event.type === 'messagesAppended' &&
        event.messages.some(
          (message) =>
            message.role === 'user' &&
            message.content === 'continue after compaction',
        ),
    );
    const completed = events.findIndex(
      (event) => event.type === 'contextCompacted',
    );
    const message = events.findIndex((event) => event.type === 'messageStarted');
    expect(inputCommitted).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(inputCommitted);
    expect(started).toBeGreaterThanOrEqual(0);
    expect(completed).toBeGreaterThan(started);
    expect(message).toBeGreaterThan(completed);
  });

  it('publishes a correlated event only when the engine consumes steering', async () => {
    const firstModelStarted = deferred<void>();
    const releaseFirstModel = deferred<void>();
    let modelCalls = 0;
    let secondRequest: AgentModelRequest | undefined;
    const inspect = defineTestCommand({
      name: 'inspect',
      summary: 'Inspect one step.',
      schema: z.object({}).strict(),
      run: () => ({ inspected: true }),
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
      environment: createTestEnvironmentHandle(),
      commandRun: createTestCommandRun([inspect]),
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
      executionLocation: {
        environmentRef: 'test',
        workingDirectory: '/workspace',
      },
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
    const inspect = defineTestCommand({
      name: 'inspect',
      summary: 'Inspect one step.',
      schema: z.object({}).strict(),
      run: () => ({ inspected: true }),
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
      environment: createTestEnvironmentHandle(),
      commandRun: createTestCommandRun([inspect]),
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
      executionLocation: {
        environmentRef: 'test',
        workingDirectory: '/workspace',
      },
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
    const inspect = defineTestCommand({
      name: 'inspect',
      summary: 'Inspect one step.',
      schema: z.object({}).strict(),
      run: () => ({ inspected: true }),
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
      environment: createTestEnvironmentHandle(),
      commandRun: createTestCommandRun([inspect]),
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
      executionLocation: {
        environmentRef: 'test',
        workingDirectory: '/workspace',
      },
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
    const inspect = defineTestCommand({
      name: 'inspect',
      summary: 'Inspect one step.',
      schema: z.object({}).strict(),
      run: () => ({ inspected: true }),
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
      environment: createTestEnvironmentHandle(),
      commandRun: createTestCommandRun([inspect]),
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
      executionLocation: {
        environmentRef: 'test',
        workingDirectory: '/workspace',
      },
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
        toolName: 'command_run',
        input: {
          commands: [
            {
              step: 1,
              command: 'command_invoke',
              input: { name: 'inspect', arguments: {} },
            },
          ],
        },
      },
    ],
  };
  return {
    text: '',
    messages: [...request.messages, message],
    newMessages: [message],
    toolCalls: [
      {
        id: 'call-steer',
        name: 'command_run',
        input: {
          commands: [
            {
              step: 1,
              command: 'command_invoke',
              input: { name: 'inspect', arguments: {} },
            },
          ],
        },
      },
    ],
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
        toolName: 'command_run',
        input: commandRunInspectInput({ step: call }),
      },
    ],
  };
  return {
    text: `before tool ${call}`,
    messages: [...request.messages, message],
    newMessages: [message],
    toolCalls: [
      {
        id,
        name: 'command_run',
        input: commandRunInspectInput({ step: call }),
      },
    ],
    usage,
    finishReason: 'tool-calls',
    provider: null,
  };
}

function orderingLabel(event: AgentRunEvent): string[] {
  switch (event.type) {
    case 'messageCompleted':
      return [`message:${event.text}`];
    case 'commandRunEvent':
      return event.event.type === 'command.started'
        ? [`command:start:${event.event.record.commandId}`]
        : event.event.type === 'command.completed'
          ? [`command:complete:${event.event.record.commandId}`]
          : [];
    default:
      return [];
  }
}

function commandRunInspectInput(arguments_: Record<string, unknown>) {
  return {
    commands: [
      {
        step: 1,
        command: 'command_invoke',
        input: { name: 'inspect', arguments: arguments_ },
      },
    ],
  };
}
