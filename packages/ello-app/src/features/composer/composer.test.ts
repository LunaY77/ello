import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@/client/session', () => ({
  dispatchStoreEvent: vi.fn(),
  getAppClient: () => ({ request: mocks.request }),
}));

import {
  selectComposerAttachments,
  selectComposerQueue,
  flushQueue,
  submitComposer,
  useComposerStore,
} from './composer';

import { initialState, useAppStore } from '@/store/store';
import { makeSnapshot, makeSummary, makeTurn } from '@/testing/fixtures';

describe('composer selectors', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    useAppStore.setState(structuredClone(initialState), true);
    useComposerStore.setState({ attachments: {}, drafts: {}, queues: {} });
  });

  it('未选中会话或尚无本地记录时保持 undefined snapshot', () => {
    const state = useComposerStore.getState();

    expect(selectComposerAttachments(state, undefined)).toBeUndefined();
    expect(selectComposerAttachments(state, 'thread-1')).toBeUndefined();
    expect(selectComposerQueue(state, undefined)).toBeUndefined();
    expect(selectComposerQueue(state, 'thread-1')).toBeUndefined();
  });

  it('直接返回 store 中已有的附件与队列引用', () => {
    const attachments = [{ path: '/tmp/a.ts', displayName: 'a.ts' }];
    const queue = [
      {
        input: [{ type: 'text' as const, text: '继续处理' }],
        preview: '继续处理',
      },
    ];
    useComposerStore.setState({
      attachments: { 'thread-1': attachments },
      queues: { 'thread-1': queue },
    });
    const state = useComposerStore.getState();

    expect(selectComposerAttachments(state, 'thread-1')).toBe(attachments);
    expect(selectComposerQueue(state, 'thread-1')).toBe(queue);
  });
});

describe('composer operations', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    useAppStore.setState(structuredClone(initialState), true);
    useComposerStore.setState({ attachments: {}, drafts: {}, queues: {} });
  });

  it('运行中排队时保留完整附件输入', async () => {
    const thread = makeSummary({ id: 'thread-1' });
    const snapshot = makeSnapshot({
      thread,
      turns: [makeTurn({ threadId: thread.id, status: 'inProgress' })],
    });
    useAppStore.setState({
      ...initialState,
      connection: { phase: 'ready', serverInfo: null, fatalError: null },
      entities: {
        ...initialState.entities,
        threads: { [thread.id]: thread },
        snapshots: { [thread.id]: snapshot },
      },
    });
    useComposerStore.setState({
      drafts: { [thread.id]: '继续处理' },
      attachments: {
        [thread.id]: [{ path: '/tmp/spec.md', displayName: 'spec.md' }],
      },
      queues: {},
    });

    await submitComposer(thread.id);

    expect(mocks.request).not.toHaveBeenCalled();
    expect(useComposerStore.getState().queues[thread.id]?.[0]).toEqual({
      input: [
        { type: 'text', text: '继续处理' },
        { type: 'file', path: '/tmp/spec.md', displayName: 'spec.md' },
      ],
      preview: '继续处理',
    });
  });

  it('发送失败时保留草稿与附件', async () => {
    const thread = makeSummary({ id: 'thread-1' });
    const snapshot = makeSnapshot({ thread });
    const attachments = [{ path: '/tmp/spec.md', displayName: 'spec.md' }];
    useAppStore.setState({
      ...initialState,
      connection: { phase: 'ready', serverInfo: null, fatalError: null },
      entities: {
        ...initialState.entities,
        threads: { [thread.id]: thread },
        snapshots: { [thread.id]: snapshot },
      },
    });
    useComposerStore.setState({
      drafts: { [thread.id]: '继续处理' },
      attachments: { [thread.id]: attachments },
      queues: {},
    });
    mocks.request.mockRejectedValueOnce(new Error('submit failed'));

    await expect(submitComposer(thread.id)).rejects.toThrow('submit failed');
    expect(useComposerStore.getState().drafts[thread.id]).toBe('继续处理');
    expect(useComposerStore.getState().attachments[thread.id]).toBe(attachments);
  });

  it('每次只发送队首,失败时不移除', async () => {
    const first = {
      input: [{ type: 'text' as const, text: 'first' }],
      preview: 'first',
    };
    const second = {
      input: [{ type: 'text' as const, text: 'second' }],
      preview: 'second',
    };
    useComposerStore.setState({
      drafts: {},
      attachments: {},
      queues: { 'thread-1': [first, second] },
    });
    mocks.request.mockResolvedValueOnce({ turn: { id: 'turn-1' } });

    await flushQueue('thread-1');

    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: first.input,
    });
    expect(useComposerStore.getState().queues['thread-1']).toEqual([second]);

    mocks.request.mockRejectedValueOnce(new Error('submit failed'));
    await expect(flushQueue('thread-1')).rejects.toThrow('submit failed');
    expect(useComposerStore.getState().queues['thread-1']).toEqual([second]);
  });
});
