/**
 * composer 的本地(UI)状态:每 Thread 独立草稿与排队消息。
 * 这是纯 UI state,不写入 Server 投影;排队消息在回合结束事件后作为新回合发送。
 */
import type { UserInput } from '@ello/agent/protocol';
import { create } from 'zustand';

import { getAppClient } from '@/client/session';
import { dispatchStoreEvent } from '@/client/session';
import { useAppStore } from '@/store/store';
import type { CatalogEntry } from '@/store/types';

export interface ComposerAttachment {
  readonly path: string;
  readonly displayName: string;
}

export interface ComposerQueueEntry {
  readonly input: readonly UserInput[];
  readonly preview: string;
}

export interface ComposerLocalState {
  readonly drafts: Readonly<Record<string, string>>;
  readonly attachments: Readonly<Record<string, readonly ComposerAttachment[]>>;
  readonly queues: Readonly<Record<string, readonly ComposerQueueEntry[]>>;
  setDraft: (threadId: string, text: string) => void;
  setAttachments: (threadId: string, files: readonly ComposerAttachment[]) => void;
  enqueue: (threadId: string, entry: ComposerQueueEntry) => void;
  shiftQueue: (threadId: string, entry: ComposerQueueEntry) => void;
}

export const useComposerStore = create<ComposerLocalState>()((set, get) => ({
  drafts: {},
  attachments: {},
  queues: {},
  setDraft: (threadId, text) =>
    set((state) => ({ drafts: { ...state.drafts, [threadId]: text } })),
  setAttachments: (threadId, files) =>
    set((state) => ({ attachments: { ...state.attachments, [threadId]: files } })),
  enqueue: (threadId, entry) =>
    set((state) => ({
      queues: {
        ...state.queues,
        [threadId]: [...(state.queues[threadId] ?? []), entry],
      },
    })),
  shiftQueue: (threadId, entry) => {
    const queue = get().queues[threadId];
    if (queue === undefined || queue[0] !== entry) {
      throw new Error(`Composer queue for ${threadId} changed during submission.`);
    }
    set((state) => {
      const queues = { ...state.queues };
      const remaining = queue.slice(1);
      if (remaining.length === 0) delete queues[threadId];
      else queues[threadId] = remaining;
      return { queues };
    });
  },
}));

/** 未创建本地记录时返回 undefined,避免 selector 构造不稳定的空数组快照。 */
export function selectComposerAttachments(
  state: ComposerLocalState,
  threadId: string | undefined,
): readonly ComposerAttachment[] | undefined {
  return threadId === undefined ? undefined : state.attachments[threadId];
}

/** 未创建本地记录时返回 undefined,队列记录只由 enqueue/shiftQueue 改写。 */
export function selectComposerQueue(
  state: ComposerLocalState,
  threadId: string | undefined,
): readonly ComposerQueueEntry[] | undefined {
  return threadId === undefined ? undefined : state.queues[threadId];
}

/** 发送或排队:运行中排队,回合结束后由 flushQueue 依次发出。 */
export async function submitComposer(threadId: string): Promise<void> {
  const { drafts, attachments, setDraft, setAttachments, enqueue } =
    useComposerStore.getState();
  const originalDraft = drafts[threadId] ?? '';
  const text = originalDraft.trim();
  const files = attachments[threadId] ?? [];
  if (text === '' && files.length === 0) return;

  const input: UserInput[] = [
    ...(text === '' ? [] : [{ type: 'text' as const, text }]),
    ...files.map(
      (file): UserInput => ({
        type: 'file',
        path: file.path,
        displayName: file.displayName,
      }),
    ),
  ];
  if (input.length === 0) return;

  const snapshot = useAppStore.getState().entities.snapshots[threadId];
  const running = snapshot?.turns.some((turn) => turn.status === 'inProgress');

  if (running === true) {
    enqueue(threadId, {
      input,
      preview: text === '' ? files.map((file) => file.displayName).join(', ') : text,
    });
    setDraft(threadId, '');
    setAttachments(threadId, []);
    return;
  }

  await getAppClient().request('turn/start', { threadId, input });
  if (useComposerStore.getState().drafts[threadId] === originalDraft) {
    setDraft(threadId, '');
  }
  if (useComposerStore.getState().attachments[threadId] === files) {
    setAttachments(threadId, []);
  }
}

const flushingThreads = new Set<string>();

/** 回合结束事件后调用:只启动下一条,其余消息等待后续回合结束。 */
export async function flushQueue(threadId: string): Promise<void> {
  if (flushingThreads.has(threadId)) return;
  const entry = useComposerStore.getState().queues[threadId]?.[0];
  if (entry === undefined) return;
  flushingThreads.add(threadId);
  try {
    await getAppClient().request('turn/start', {
      threadId,
      input: entry.input,
    });
    useComposerStore.getState().shiftQueue(threadId, entry);
  } finally {
    flushingThreads.delete(threadId);
  }
}

/** 拉取模型目录(model/list 需要 cwd)。 */
export async function loadModelCatalog(cwd: string): Promise<void> {
  const result = await getAppClient().request('model/list', { cwd });
  dispatchStoreEvent({ kind: 'catalog-loaded', catalog: 'models', entries: result.data });
}

export function modelDisplayName(entry: CatalogEntry | undefined, rawName: string): string {
  if (entry === undefined) return rawName;
  return entry.title ?? entry.name;
}
