import { describe, expect, it } from 'vitest';

import { ToolScheduler } from '../agent/engine/core/tool-scheduler.js';
import {
  defineDeferredTool,
  defineTool,
  z,
} from '../agent/engine/index.js';

describe('ToolScheduler', () => {
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
        onToolDeferred: async (item) => deferred.push(item.toolCallId),
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
