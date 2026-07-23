import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchStoreEvent: vi.fn(),
  request: vi.fn(),
}));

vi.mock('@/client/session', () => ({
  dispatchStoreEvent: mocks.dispatchStoreEvent,
  getAppClient: () => ({ request: mocks.request }),
}));

import { archiveThread, openThread } from './thread';

import { initialState, useAppStore } from '@/store/store';
import { makeSummary } from '@/testing/fixtures';

describe('Thread actions', () => {
  beforeEach(() => {
    mocks.dispatchStoreEvent.mockReset();
    mocks.request.mockReset();
    useAppStore.setState(structuredClone(initialState), true);
  });

  it('Server 确认 archive 后更新投影并清空当前可提交视图', async () => {
    const thread = makeSummary({ id: 'thread-archive' });
    const archived = { ...thread, archived: true };
    useAppStore.setState({
      ...initialState,
      entities: { ...initialState.entities, threads: { [thread.id]: thread } },
      view: { ...initialState.view, selectedThreadId: thread.id },
    });
    mocks.request.mockResolvedValue({ thread: archived });

    await archiveThread(thread.id);

    expect(mocks.request).toHaveBeenCalledWith('thread/archive', {
      threadId: thread.id,
    });
    expect(mocks.dispatchStoreEvent).toHaveBeenCalledWith({
      kind: 'thread-upserted',
      thread: archived,
    });
    expect(useAppStore.getState().view.selectedThreadId).toBeNull();
  });

  it('Server 拒绝 archive 时保留当前视图且不伪造客户端状态', async () => {
    const thread = makeSummary({ id: 'thread-busy' });
    useAppStore.setState({
      ...initialState,
      entities: { ...initialState.entities, threads: { [thread.id]: thread } },
      view: { ...initialState.view, selectedThreadId: thread.id },
    });
    const error = new Error('Thread is busy.');
    mocks.request.mockRejectedValue(error);

    await expect(archiveThread(thread.id)).rejects.toBe(error);

    expect(mocks.dispatchStoreEvent).not.toHaveBeenCalled();
    expect(useAppStore.getState().view.selectedThreadId).toBe(thread.id);
  });

  it('归档 Thread 必须先 unarchive，open 不发送 resume 请求', async () => {
    const thread = makeSummary({ id: 'thread-archived', archived: true });
    useAppStore.setState({
      ...initialState,
      entities: { ...initialState.entities, threads: { [thread.id]: thread } },
    });

    await expect(openThread(thread.id)).rejects.toThrow(
      `Thread ${thread.id} must be unarchived before opening.`,
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
