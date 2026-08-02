/**
 * 本文件验证 tool-scheduler 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { describe, expect, it } from 'vitest';

import {
  defineDeferredTool,
  defineTool,
  type AnyAgentTool,
  z,
} from '../../src/features/agent/engine/index.js';
import { ToolScheduler } from '../../src/features/agent/engine/tool-scheduler.js';
import type { EnvironmentHandle } from '../../src/features/environment/index.js';
import { createTestEnvironmentHandle } from '../support/environment.js';

describe('ToolScheduler', () => {
  it('在审批和执行前统一校验 immediate 工具输入', async () => {
    let approvals = 0;
    let executions = 0;
    const tool = defineTool({
      name: 'write',
      description: 'Write a file',
      discovery: { aliases: [], risk: 'workspace-write' },
      input: z.object({ path: z.string().min(1) }).strict(),
      approval: () => {
        approvals += 1;
        return 'auto';
      },
      execute: () => {
        executions += 1;
      },
    });
    const scheduler = new ToolScheduler({
      runId: 'run-1',
      turnIndex: () => 0,
      tools: [tool],
      callableToolNames: new Set([tool.name]),
      environment: createTestEnvironmentHandle(),
      metadata: {},
      signal: new AbortController().signal,
    });
    const events: string[] = [];

    const result = await scheduler.schedule(
      [{ id: 'call-invalid', name: 'write', input: { path: '', extra: true } }],
      sink(events),
    );

    expect(approvals).toBe(0);
    expect(executions).toBe(0);
    expect(result.pending).toEqual([]);
    expect(result.toolCalls[0]?.error?.message).toBeDefined();
    expect(events).toEqual(['started', 'failed']);
  });

  it('批准后的 immediate 工具仍重新校验输入', async () => {
    let executions = 0;
    const tool = defineTool({
      name: 'write',
      description: 'Write a file',
      discovery: { aliases: [], risk: 'workspace-write' },
      input: z.object({ path: z.string().min(1) }).strict(),
      execute: () => {
        executions += 1;
      },
    });
    const scheduler = new ToolScheduler({
      runId: 'run-1',
      turnIndex: () => 0,
      tools: [tool],
      callableToolNames: new Set([tool.name]),
      environment: createTestEnvironmentHandle(),
      metadata: {},
      signal: new AbortController().signal,
    });
    const events: string[] = [];

    const result = await scheduler.executeApproved(
      { id: 'call-invalid', name: 'write', input: {} },
      sink(events),
    );

    expect(executions).toBe(0);
    expect(result.error?.message).toBeDefined();
    expect(events).toEqual(['started', 'failed']);
  });

  it('normalizes approval errors into a tool failure', async () => {
    const tool = defineTool({
      name: 'apply_patch',
      description: 'Apply a patch',
      discovery: {
        aliases: ['patch'],
        risk: 'workspace-write',
      },
      input: z.object({ patch: z.string() }).strict(),
      approval: () => {
        throw new Error('Patch file name is missing.');
      },
      execute: async () => 'must not execute',
    });
    const events: string[] = [];
    const scheduler = new ToolScheduler({
      runId: 'run-1',
      turnIndex: () => 0,
      tools: [tool],
      callableToolNames: new Set([tool.name]),
      environment: createTestEnvironmentHandle(),
      metadata: {},
      signal: new AbortController().signal,
    });

    const result = await scheduler.schedule(
      [{ id: 'call-1', name: 'apply_patch', input: { patch: '@@' } }],
      {
        onToolStarted: async () => {
          events.push('started');
        },
        onApprovalRequired: async () => {
          events.push('approval');
        },
        onToolDeferred: async () => {
          events.push('deferred');
        },
        onToolCompleted: async () => {
          events.push('completed');
        },
        onToolFailed: async (_id, error) => {
          events.push(`failed:${error.message}`);
        },
      },
    );

    expect(result.pending).toHaveLength(0);
    expect(result.toolCalls[0]).toMatchObject({
      id: 'call-1',
      error: { message: 'Patch file name is missing.' },
    });
    expect(result.messages).toHaveLength(1);
    expect(events).toEqual(['started', 'failed:Patch file name is missing.']);
  });

  it('defers one deferred call without executing it', async () => {
    const tool = defineDeferredTool({
      name: 'ask',
      description: 'Ask',
      discovery: { aliases: [], risk: 'readonly' },
      input: z.object({ question: z.string() }).strict(),
    });
    const scheduler = new ToolScheduler({
      runId: 'run-1',
      turnIndex: () => 0,
      tools: [tool],
      callableToolNames: new Set([tool.name]),
      environment: createTestEnvironmentHandle(),
      metadata: {},
      signal: new AbortController().signal,
    });
    const deferred: string[] = [];
    const result = await scheduler.schedule(
      [{ id: 'call-1', name: 'ask', input: { question: 'Choose?' } }],
      {
        onToolStarted: async () => {},
        onApprovalRequired: async () => {},
        onToolDeferred: async (item) => {
          deferred.push(item.toolCallId);
        },
        onToolCompleted: async () => {},
        onToolFailed: async () => {},
      },
    );
    expect(result.messages).toEqual([]);
    expect(result.pending).toEqual([
      {
        kind: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'ask',
        input: { question: 'Choose?' },
      },
    ]);
    expect(deferred).toEqual(['call-1']);
  });

  it('rejects a mixed deferred batch before side effects execute', async () => {
    let executions = 0;
    const immediate = defineTool({
      name: 'write',
      description: 'Write',
      discovery: { aliases: [], risk: 'workspace-write' },
      input: z.object({}).strict(),
      execute: () => {
        executions += 1;
      },
    });
    const deferred = defineDeferredTool({
      name: 'ask',
      description: 'Ask',
      discovery: { aliases: [], risk: 'readonly' },
      input: z.object({}).strict(),
    });
    const scheduler = new ToolScheduler({
      runId: 'run-1',
      turnIndex: () => 0,
      tools: [immediate, deferred],
      callableToolNames: new Set(['write', 'ask']),
      environment: createTestEnvironmentHandle(),
      metadata: {},
      signal: new AbortController().signal,
    });
    const result = await scheduler.schedule(
      [
        { id: 'call-1', name: 'write', input: {} },
        { id: 'call-2', name: 'ask', input: {} },
      ],
      {
        onToolStarted: async () => {},
        onApprovalRequired: async () => {},
        onToolDeferred: async () => {},
        onToolCompleted: async () => {},
        onToolFailed: async () => {},
      },
    );
    expect(executions).toBe(0);
    expect(result.pending).toEqual([]);
    expect(result.messages).toHaveLength(2);
  });

  it('并发执行连续的 parallel 工具，并按原调用顺序回灌结果', async () => {
    const active: number[] = [];
    let peak = 0;
    const makeReader = (name: string) =>
      defineTool({
        name,
        description: 'Read',
        discovery: { aliases: [], risk: 'readonly' },
        input: z.object({}).strict(),
        capabilities: () => ({
          concurrencySafe: true,
          readOnly: true,
          destructive: false,
        }),
        execute: async () => {
          active.push(1);
          peak = Math.max(peak, active.length);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active.pop();
          return name;
        },
      });
    const writer = defineTool({
      name: 'write',
      description: 'Write',
      discovery: { aliases: [], risk: 'workspace-write' },
      input: z.object({}).strict(),
      execute: () => 'write',
    });
    const tools = [makeReader('read'), makeReader('grep'), writer];
    const scheduler = new ToolScheduler({
      runId: 'run-parallel',
      turnIndex: () => 0,
      tools,
      callableToolNames: new Set(tools.map((tool) => tool.name)),
      environment: createTestEnvironmentHandle(),
      metadata: {},
      signal: new AbortController().signal,
    });

    const result = await scheduler.schedule(
      [
        { id: 'c1', name: 'read', input: {} },
        { id: 'c2', name: 'grep', input: {} },
        { id: 'c3', name: 'write', input: {} },
      ],
      sink([]),
    );

    expect(peak).toBe(2);
    expect(result.toolCalls.map((call) => call.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('写工具切断并发段，其前后的只读工具不与它同时执行', async () => {
    const order: string[] = [];
    const reader = (name: string) =>
      defineTool({
        name,
        description: 'Read',
        discovery: { aliases: [], risk: 'readonly' },
        input: z.object({}).strict(),
        capabilities: () => ({
          concurrencySafe: true,
          readOnly: true,
          destructive: false,
        }),
        execute: async () => {
          order.push(`${name}:start`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(`${name}:end`);
        },
      });
    const writer = defineTool({
      name: 'write',
      description: 'Write',
      discovery: { aliases: [], risk: 'workspace-write' },
      input: z.object({}).strict(),
      execute: async () => {
        order.push('write:start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('write:end');
      },
    });
    const tools = [reader('read'), writer, reader('grep')];
    const scheduler = new ToolScheduler({
      runId: 'run-segment',
      turnIndex: () => 0,
      tools,
      callableToolNames: new Set(tools.map((tool) => tool.name)),
      environment: createTestEnvironmentHandle(),
      metadata: {},
      signal: new AbortController().signal,
    });

    await scheduler.schedule(
      [
        { id: 'c1', name: 'read', input: {} },
        { id: 'c2', name: 'write', input: {} },
        { id: 'c3', name: 'grep', input: {} },
      ],
      sink([]),
    );

    expect(order).toEqual([
      'read:start',
      'read:end',
      'write:start',
      'write:end',
      'grep:start',
      'grep:end',
    ]);
  });

  it('同一 environment 的不同 scheduler 共享读写执行门', async () => {
    const environment = createTestEnvironmentHandle();
    const order: string[] = [];
    let releaseRead: (() => void) | undefined;
    const readFinished = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const read = defineTool({
      name: 'read',
      description: 'Read',
      discovery: { aliases: [], risk: 'readonly' },
      input: z.object({}).strict(),
      capabilities: () => ({
        concurrencySafe: true,
        readOnly: true,
        destructive: false,
      }),
      execute: async () => {
        order.push('read:start');
        await readFinished;
        order.push('read:end');
      },
    });
    const write = defineTool({
      name: 'write',
      description: 'Write',
      discovery: { aliases: [], risk: 'workspace-write' },
      input: z.object({}).strict(),
      execute: () => {
        order.push('write');
      },
    });
    const reader = schedulerFor('reader', [read], environment);
    const writer = schedulerFor('writer', [write], environment);

    const reading = reader.schedule(
      [{ id: 'read-call', name: 'read', input: {} }],
      sink([]),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const writing = writer.schedule(
      [{ id: 'write-call', name: 'write', input: {} }],
      sink([]),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(order).toEqual(['read:start']);
    releaseRead?.();
    await Promise.all([reading, writing]);
    expect(order).toEqual(['read:start', 'read:end', 'write']);
  });

  it('按解析后的 input 动态判定并发并对不完整声明 fail closed', async () => {
    let active = 0;
    let peak = 0;
    const inspect = defineTool({
      name: 'inspect',
      description: 'Inspect or mutate',
      discovery: { aliases: [], risk: 'external' },
      input: z.object({ mode: z.enum(['read', 'write']) }).strict(),
      capabilities: ({ mode }) =>
        mode === 'read'
          ? {
              concurrencySafe: true,
              readOnly: true,
              destructive: false,
            }
          : { destructive: true },
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
    });
    const scheduler = schedulerFor(
      'dynamic',
      [inspect],
      createTestEnvironmentHandle(),
    );

    await scheduler.schedule(
      [
        { id: 'c1', name: 'inspect', input: { mode: 'read' } },
        { id: 'c2', name: 'inspect', input: { mode: 'read' } },
        { id: 'c3', name: 'inspect', input: { mode: 'write' } },
      ],
      sink([]),
    );

    expect(peak).toBe(2);
  });
});

function schedulerFor(
  runId: string,
  tools: readonly AnyAgentTool[],
  environment: EnvironmentHandle,
): ToolScheduler {
  return new ToolScheduler({
    runId,
    turnIndex: () => 0,
    tools,
    callableToolNames: new Set(tools.map((tool) => tool.name)),
    environment,
    metadata: {},
    signal: new AbortController().signal,
  });
}

function sink(events: string[]) {
  return {
    onToolStarted: async () => {
      events.push('started');
    },
    onApprovalRequired: async () => {
      events.push('approval');
    },
    onToolDeferred: async () => {
      events.push('deferred');
    },
    onToolCompleted: async () => {
      events.push('completed');
    },
    onToolFailed: async () => {
      events.push('failed');
    },
  };
}
