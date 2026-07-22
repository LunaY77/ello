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
  z,
} from '../../src/features/agent/engine/index.js';
import { ToolScheduler } from '../../src/features/agent/engine/tool-scheduler.js';

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
      environment: {},
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
      environment: {},
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
      environment: {},
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
      environment: {},
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
      environment: {},
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
});

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
