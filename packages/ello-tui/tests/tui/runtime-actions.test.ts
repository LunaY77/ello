import { describe, expect, it, vi } from 'vitest';

import type { ThreadClient } from '../../src/client/thread-client.js';
import { archiveActiveThread } from '../../src/tui/hooks/use-runtime-actions.js';

describe('runtime actions', () => {
  it('archives on the Server before closing and exiting the active Thread', async () => {
    const calls: string[] = [];
    const request = vi.fn(async () => {
      calls.push('archive');
      return { thread: {} };
    });
    const close = vi.fn(async () => {
      calls.push('close');
    });
    const exit = vi.fn(() => {
      calls.push('exit');
    });
    const thread = {
      threadId: 'thr_archive',
      request,
      close,
    } as unknown as ThreadClient;

    await archiveActiveThread(thread, exit);

    expect(request).toHaveBeenCalledWith('thread/archive', {
      threadId: 'thr_archive',
    });
    expect(calls).toEqual(['archive', 'close', 'exit']);
  });

  it('keeps the active Thread open when the Server rejects archive', async () => {
    const serverError = new Error('Thread is busy.');
    const request = vi.fn(async () => {
      throw serverError;
    });
    const close = vi.fn();
    const exit = vi.fn();
    const thread = {
      threadId: 'thr_busy',
      request,
      close,
    } as unknown as ThreadClient;

    await expect(archiveActiveThread(thread, exit)).rejects.toBe(serverError);
    expect(close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
