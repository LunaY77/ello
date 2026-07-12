import { describe, expect, it } from 'vitest';

import { ToolScheduler } from '../core/tool-scheduler.js';
import { defineTool, z } from '../index.js';

describe('ToolScheduler', () => {
  it('normalizes approval errors into a tool failure', async () => {
    const tool = defineTool({
      name: 'apply_patch',
      description: 'Apply a patch',
      input: z.object({ patch: z.string() }),
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
      environment: {},
      metadata: {},
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
});
