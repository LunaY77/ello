import { describe, expect, it } from 'vitest';

import { GlobalHooks, ToolHooks, type RunContextLike } from '../index.js';

function makeCtx(): RunContextLike<{ runId: string }> {
  return { deps: { runId: 'test' } };
}

describe('ToolHooks', () => {
  it('runs tool pre hook', async () => {
    const hooks = new ToolHooks({
      preHooks: {
        shell_exec: async (_ctx, args) => ({ ...args, extra: true }),
      },
    });

    await expect(
      hooks.runPre(makeCtx(), 'shell_exec', { command: 'ls' }),
    ).resolves.toEqual({
      command: 'ls',
      extra: true,
    });
  });

  it('runs tool post hook', async () => {
    const hooks = new ToolHooks({
      postHooks: {
        shell_exec: async (_ctx, result) => `modified: ${String(result)}`,
      },
    });

    await expect(
      hooks.runPost(makeCtx(), 'shell_exec', 'original'),
    ).resolves.toBe('modified: original');
  });

  it('runs global hooks', async () => {
    const hooks = new ToolHooks({
      globalHooks: new GlobalHooks({
        pre: async (_ctx, toolName, args) => ({ ...args, _tool: toolName }),
        post: async (_ctx, toolName, result) => ({ tool: toolName, result }),
      }),
    });

    await expect(
      hooks.runPre(makeCtx(), 'any_tool', { x: 1 }),
    ).resolves.toEqual({
      x: 1,
      _tool: 'any_tool',
    });
    await expect(hooks.runPost(makeCtx(), 'my_tool', 'value')).resolves.toEqual(
      {
        tool: 'my_tool',
        result: 'value',
      },
    );
  });

  it('passes through when no hook is registered', async () => {
    const hooks = new ToolHooks();

    await expect(hooks.runPre(makeCtx(), 't', { a: 1 })).resolves.toEqual({
      a: 1,
    });
    await expect(hooks.runPost(makeCtx(), 't', 'res')).resolves.toBe('res');
  });
});
