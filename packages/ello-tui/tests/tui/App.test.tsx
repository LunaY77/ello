import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ServerNotification,
  ThreadSnapshot,
  ThreadSummary,
  Turn,
} from '../../src/api/protocol-types.js';
import type { ThreadClientEvent } from '../../src/client/client-events.js';
import { ThreadClient } from '../../src/client/thread-client.js';
import { App } from '../../src/tui/App.js';

const createdAt = '2026-07-18T00:00:00.000Z';
const roots: string[] = [];
const originalElloHome = process.env.ELLO_HOME;

afterEach(async () => {
  if (originalElloHome === undefined) delete process.env.ELLO_HOME;
  else process.env.ELLO_HOME = originalElloHome;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('App typed client behavior', () => {
  it('/workspace 只通过 workspace/list 加载 Server 数据', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, '/workspace');

    await vi.waitFor(() => {
      expect(harness.request).toHaveBeenCalledWith('workspace/list', {});
      expect(view.lastFrame()).toContain('/workspace/refactor/client-server');
    });
    view.unmount();
  });

  it('@file 仅提交结构化文件引用，不在 Client 读取文件内容', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, 'review @src/a.ts please');

    await vi.waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('fs/search', {
        cwd: '/workspace',
        query: 'src/a.ts',
        kind: 'any',
        limit: 50,
      }),
    );
    await vi.waitFor(() =>
      expect(harness.submitInput).toHaveBeenCalledWith([
        { type: 'text', text: 'review please' },
        {
          type: 'file',
          path: '/workspace/src/a.ts',
          displayName: 'src/a.ts',
        },
      ]),
    );
    view.unmount();
  });

  it('未匹配 mention 和邮箱保持普通文本，不制造文件输入', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, 'email dev@example.test and @missing.ts');

    await vi.waitFor(() =>
      expect(harness.submitInput).toHaveBeenCalledWith([
        { type: 'text', text: 'email dev@example.test and @missing.ts' },
      ]),
    );
    expect(
      harness.request.mock.calls.some(
        ([method, params]) =>
          method === 'fs/search' &&
          (params as { readonly query?: string }).query === 'example.test',
      ),
    ).toBe(false);
    view.unmount();
  });

  it('重复 @file 引用只提交一个稳定的结构化文件输入', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, 'compare @src/a.ts with @src/a.ts');

    await vi.waitFor(() =>
      expect(harness.submitInput).toHaveBeenCalledWith([
        { type: 'text', text: 'compare with' },
        {
          type: 'file',
          path: '/workspace/src/a.ts',
          displayName: 'src/a.ts',
        },
      ]),
    );
    view.unmount();
  });

  it('文件搜索失败时显示错误且不提交半成品输入', async () => {
    const harness = createThreadHarness(snapshot(), {
      fileSearchError: new Error('file search unavailable'),
    });
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, 'review @src/a.ts');

    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('file search unavailable'),
    );
    expect(harness.submitInput).not.toHaveBeenCalled();
    view.unmount();
  });

  it('/rewind 按 entry 对应 turn fork，关闭旧 thread 并回填 prompt', async () => {
    const source = createThreadHarness(snapshot('thr_source', true));
    const next = createThreadHarness(snapshot('thr_fork'));
    source.fork.mockResolvedValue(next.thread);
    const view = render(<App thread={source.thread} />);
    await waitForCatalogs(source);

    await submitCommand(view, '/rewind item_user');

    await vi.waitFor(() => {
      expect(source.fork).toHaveBeenCalledWith('turn_1');
      expect(source.close).toHaveBeenCalledOnce();
      expect(view.lastFrame()).toContain('original prompt');
    });
    view.unmount();
  });

  it('/models 只改写明确选择的全局模型引用', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, '/models');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Select model reference'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Select primary_model'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('config/write', {
        cwd: '/workspace',
        source: 'global',
        path: ['primary_model'],
        operation: 'set',
        value: 'mock/new',
      }),
    );
    view.unmount();
  });

  it('/effort 通过 agent 写入当前模型的全局配置', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, '/effort max');

    await vi.waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('agent/effort/update', {
        cwd: '/workspace',
        agent: 'build',
        effort: 'max',
      }),
    );
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Thinking effort set to max'),
    );
    view.unmount();
  });

  it('/compact 用完整 checkpoint 替换进行中提示', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, '/compact');

    await vi.waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('thread/compact/start', {
        threadId: 'thr_1',
      }),
    );
    await vi.waitFor(() => {
      const frame = view.lastFrame();
      expect(frame).toContain(
        'Context compacted · 12 -> 3 messages · 4.1k tokens before',
      );
      expect(frame).toContain('## Goal');
      expect(frame).toContain('Preserve the active compact checkpoint.');
      expect(frame).not.toContain('jobId');
      expect(frame).not.toContain('Compacting context…');
    });
    view.unmount();
  });

  it('/compact 进行中可用 Ctrl+C 中断', async () => {
    let rejectCompact!: (error: Error) => void;
    const compact = new Promise<never>((_resolve, reject) => {
      rejectCompact = reject;
    });
    const harness = createThreadHarness(snapshot(), {
      compact: () => compact,
    });
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, '/compact');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Compacting context…'),
    );

    view.stdin.write('\x03');

    await vi.waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('thread/compact/interrupt', {
        threadId: 'thr_1',
      }),
    );
    await vi.waitFor(() =>
      expect(view.lastFrame()).not.toContain('Compacting context…'),
    );
    rejectCompact(new Error('context compaction aborted'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.lastFrame()).not.toContain('context compaction aborted');
    view.unmount();
  });

  it('Hero 只显示一次 Server 返回的具体 settings', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('agent: build'));
    expect(view.lastFrame()).toContain('primary: mock/new · auxiliary:');
    expect(view.lastFrame()).toContain('mock/flash');
    expect(view.lastFrame()).toContain('mode: ask-before-changes');
    expect(view.lastFrame()?.match(/Ello Coding Agent/gu)).toHaveLength(1);
    view.unmount();
  });

  it('Shift+Tab 通过 ThreadClient 切换 mode', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    view.stdin.write('\u001b[Z');

    await vi.waitFor(() =>
      expect(harness.setMode).toHaveBeenCalledWith('accept-edits'),
    );
    view.unmount();
  });

  it('上下方向键切换 Server 历史输入', async () => {
    const harness = createThreadHarness(snapshot('thr_history', true));
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    view.stdin.write('\u001b[A');
    view.stdin.write('\r');

    await vi.waitFor(() =>
      expect(harness.submitInput).toHaveBeenCalledWith([
        { type: 'text', text: 'original prompt' },
      ]),
    );
    view.unmount();
  });

  it('无 agent 运行轨迹时 Ctrl+C 中断并回填刚提交的输入', async () => {
    let resolveTurn!: (turnId: string) => void;
    const turnStarted = new Promise<string>((resolve) => {
      resolveTurn = resolve;
    });
    const harness = createThreadHarness(snapshot(), {
      submitInput: () => turnStarted,
    });
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, 'retry this prompt');
    await vi.waitFor(() => expect(harness.submitInput).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Enter steers this run'),
    );

    view.stdin.write('\x03');

    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('retry this prompt'),
    );
    expect(harness.interrupt).not.toHaveBeenCalled();

    resolveTurn('turn_new');
    await vi.waitFor(() => expect(harness.interrupt).toHaveBeenCalledOnce());
    view.unmount();
  });

  it('assistant 只有流式输出尚未完成时 Ctrl+C 仍回填输入', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, 'restore after partial stream');
    const turn: Turn = {
      id: 'turn_new',
      threadId: 'thr_1',
      status: 'inProgress',
      items: [],
      startedAt: createdAt,
    };
    const item = {
      id: 'item_partial',
      turnId: turn.id,
      type: 'agentMessage' as const,
      text: '',
      phase: 'commentary' as const,
      status: 'inProgress' as const,
      createdAt,
    };
    harness.emit(notification('turn/started', 2, { turnId: turn.id, turn }));
    harness.emit(
      notification('thread/status/changed', 3, {
        status: 'running',
        activeFlags: ['turn'],
      }),
    );
    harness.emit(
      notification('item/started', 4, {
        turnId: turn.id,
        itemId: item.id,
        item,
      }),
    );
    harness.emit(
      notification('item/agentMessage/delta', 5, {
        turnId: turn.id,
        itemId: item.id,
        delta: 'partial output',
      }),
    );

    view.stdin.write('\x03');

    await vi.waitFor(() => expect(harness.interrupt).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('restore after partial stream'),
    );
    view.unmount();
  });

  it('assistant message 完成后 Ctrl+C 只中断而不回填', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, 'do not restore completed trace');
    const turn: Turn = {
      id: 'turn_new',
      threadId: 'thr_1',
      status: 'inProgress',
      items: [],
      startedAt: createdAt,
    };
    const item = {
      id: 'item_completed',
      turnId: turn.id,
      type: 'agentMessage' as const,
      text: '',
      phase: 'final' as const,
      status: 'inProgress' as const,
      createdAt,
    };
    harness.emit(notification('turn/started', 2, { turnId: turn.id, turn }));
    harness.emit(
      notification('thread/status/changed', 3, {
        status: 'running',
        activeFlags: ['turn'],
      }),
    );
    harness.emit(
      notification('item/started', 4, {
        turnId: turn.id,
        itemId: item.id,
        item,
      }),
    );
    harness.emit(
      notification('item/completed', 5, {
        turnId: turn.id,
        itemId: item.id,
        item: {
          ...item,
          text: 'completed answer',
          status: 'completed',
        },
      }),
    );
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('completed answer'),
    );

    view.stdin.write('\x03');

    await vi.waitFor(() => expect(harness.interrupt).toHaveBeenCalledOnce());
    expect(view.lastFrame()).not.toContain('do not restore completed trace');
    view.unmount();
  });

  it('/resume 隐藏空白 thread，空白 TUI 退出时删除当前 thread', async () => {
    const named = summary('thr_named', 'Named session', 'work');
    const blank = summary('thr_blank', '', '');
    const harness = createThreadHarness(snapshot(), {
      sessions: [blank, named],
    });
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, '/resume');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Named session'));
    expect(view.lastFrame()).not.toContain('Untitled session');
    view.stdin.write('\x03');

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('thread/delete', {
        threadId: 'thr_1',
      }),
    );
  });

  it('/settings 中的 theme 立即生效并写入 Client 本地 tui.json', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-tui-app-'));
    roots.push(root);
    process.env.ELLO_HOME = root;
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, '/settings');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('appearance.theme'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Set global'));
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('appearance.theme → global'),
    );
    view.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(selectedLine(view.lastFrame(), 'github-dark')).toContain('›'),
    );
    view.stdin.write('\r');

    await vi.waitFor(async () => {
      const persisted = JSON.parse(
        await readFile(path.join(root, 'tui.json'), 'utf8'),
      ) as { readonly theme: string };
      expect(persisted.theme).toBe('github-dark');
    });
    expect(
      harness.request.mock.calls.some(([method]) => method === 'config/write'),
    ).toBe(false);
    view.unmount();
  });

  it('/settings 将 Server setting 写入选择的配置作用域', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, '/settings');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('appearance.theme'),
    );
    view.stdin.write('initial_mode');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('initial_mode');
      expect(view.lastFrame()).not.toContain('appearance.theme =');
    });
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Set global'));
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('initial_mode → global'),
    );
    view.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(selectedLine(view.lastFrame(), 'accept-edits')).toContain('›'),
    );
    view.stdin.write('\r');

    await vi.waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('config/write', {
        cwd: '/workspace',
        source: 'global',
        path: ['initial_mode'],
        operation: 'set',
        value: 'accept-edits',
      }),
    );
    view.unmount();
  });
});

interface ThreadHarness {
  readonly thread: ThreadClient;
  readonly request: ReturnType<typeof vi.fn>;
  readonly fork: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly interrupt: ReturnType<typeof vi.fn>;
  readonly setMode: ReturnType<typeof vi.fn>;
  readonly submitInput: ReturnType<typeof vi.fn>;
  emit(notification: ServerNotification): void;
}

function createThreadHarness(
  initialSnapshot: ThreadSnapshot,
  options: {
    readonly compact?: () => Promise<unknown>;
    readonly fileSearchError?: Error;
    readonly submitInput?: () => Promise<string>;
    readonly sessions?: readonly ThreadSummary[];
  } = {},
): ThreadHarness {
  const config = modelConfig();
  const request = vi.fn(async (method: string, _params?: unknown) => {
    switch (method) {
      case 'model/list':
        return {
          data: [
            {
              id: 'mock/new',
              name: 'new',
              title: 'New model',
              enabled: true,
              metadata: { protocol: 'openai', contextWindow: 200000 },
            },
            {
              id: 'mock/flash',
              name: 'flash',
              title: 'Flash model',
              enabled: true,
              metadata: { protocol: 'openai', contextWindow: 200000 },
            },
          ],
        };
      case 'skills/list':
      case 'task/list':
        return { data: [] };
      case 'agent/list':
        return {
          data: [
            {
              id: 'build',
              name: 'build',
              enabled: true,
              metadata: { mode: 'primary', model: 'primary_model' },
            },
          ],
        };
      case 'agent/effort/update':
        return {
          agent: 'build',
          selector: 'primary_model',
          model: 'mock/new',
          effort: 'max',
        };
      case 'thread/compact/start':
        if (options.compact !== undefined) return options.compact();
        return {
          id: 'compaction-7',
          threadId: initialSnapshot.thread.id,
          turnId: 'turn_1',
          createdAt,
          compactor: 'ello-thread-compactor',
          beforeMessageCount: 12,
          afterMessageCount: 3,
          keptMessageCount: 2,
          tokensBefore: 4_096,
          summary: '## Goal\nPreserve the active compact checkpoint.',
          metadata: { summarizedMessageCount: 10 },
        };
      case 'thread/compact/interrupt':
        return { ok: true };
      case 'config/read':
      case 'config/write':
        return { config };
      case 'thread/delete':
        return { ok: true };
      case 'config/settings':
        return {
          data: [
            {
              id: 'initial_mode',
              path: ['initial_mode'],
              label: 'Initial Mode',
              description: 'Initial mode for new threads.',
              group: 'General',
              type: 'enum',
              value: 'ask-before-changes',
              source: 'global',
              writableScopes: ['global', 'project'],
              effect: 'newThread',
              options: ['ask-before-changes', 'accept-edits', 'plan', 'bypass'],
              sensitive: false,
            },
          ],
        };
      case 'workspace/list':
        return {
          data: [
            {
              id: 'workspace-1',
              kind: 'refactor',
              name: 'client-server',
              rootPath: '/workspace/refactor/client-server',
              status: 'active',
              branch: 'refactor/client-server',
              repositories: [],
              createdAt,
              updatedAt: createdAt,
            },
          ],
        };
      case 'thread/list':
        return { data: options.sessions ?? [] };
      case 'fs/search':
        if (options.fileSearchError !== undefined) {
          throw options.fileSearchError;
        }
        return {
          data: [
            {
              path: '/workspace/src/a.ts',
              name: 'a.ts',
              kind: 'file',
            },
          ],
        };
      default:
        throw new Error(`Unexpected App test RPC ${method}.`);
    }
  });
  const fork = vi.fn();
  const close = vi.fn(async () => undefined);
  const interrupt = vi.fn(async () => undefined);
  const setMode = vi.fn(async () => undefined);
  const submitInput = vi.fn(options.submitInput ?? (async () => 'turn_new'));
  const listeners = new Set<(event: ThreadClientEvent) => void>();
  const thread = {
    threadId: initialSnapshot.thread.id,
    cwd: initialSnapshot.thread.cwd,
    snapshot: initialSnapshot,
    subscribe: (listener: (event: ThreadClientEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadHistory: async () => undefined,
    request,
    fork,
    close,
    interrupt,
    setMode,
    submitInput,
  } as unknown as ThreadClient;
  return {
    thread,
    request,
    fork,
    close,
    interrupt,
    setMode,
    submitInput,
    emit: (notification: ServerNotification) => {
      for (const listener of listeners) {
        listener({ type: 'notification', notification });
      }
    },
  };
}

function snapshot(threadId = 'thr_1', withHistory = false): ThreadSnapshot {
  return {
    thread: {
      id: threadId,
      rootId: threadId,
      cwd: '/workspace',
      name: '',
      preview: '',
      status: 'idle',
      archived: false,
      createdAt,
      updatedAt: createdAt,
    },
    settings: {
      mode: 'ask-before-changes',
      agent: 'build',
    },
    turns: withHistory
      ? [
          {
            id: 'turn_1',
            threadId,
            status: 'completed',
            items: [
              {
                id: 'item_user',
                turnId: 'turn_1',
                type: 'userMessage',
                text: 'original prompt',
                createdAt,
              },
            ],
            startedAt: createdAt,
            completedAt: createdAt,
          },
        ]
      : [],
    pendingServerRequests: [],
    goal: null,
    plan: null,
    usage: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 0,
    },
    seq: withHistory ? 5 : 1,
  };
}

function modelConfig() {
  return {
    initial_mode: 'ask-before-changes',
    bypass_enabled: true,
    primary_model: 'mock/new',
    auxiliary_model: 'mock/flash',
  };
}

async function waitForCatalogs(harness: ThreadHarness): Promise<void> {
  await vi.waitFor(() =>
    expect(harness.request).toHaveBeenCalledWith('config/read', {
      cwd: '/workspace',
      includeSources: false,
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function submitCommand(
  view: ReturnType<typeof render>,
  command: string,
): Promise<void> {
  view.stdin.write(command);
  await vi.waitFor(() => expect(view.lastFrame()).toContain(command));
  view.stdin.write('\r');
}

function selectedLine(frame: string | undefined, value: string): string {
  return frame?.split('\n').find((line) => line.includes(value)) ?? '';
}

function summary(id: string, name: string, preview: string): ThreadSummary {
  return {
    id,
    rootId: id,
    cwd: '/workspace',
    name,
    preview,
    status: 'idle',
    archived: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function notification<M extends ServerNotification['method']>(
  method: M,
  seq: number,
  params: Omit<
    Extract<ServerNotification, { method: M }>['params'],
    'threadId' | 'seq'
  >,
): Extract<ServerNotification, { method: M }> {
  return {
    method,
    params: { threadId: 'thr_1', seq, ...params },
  } as unknown as Extract<ServerNotification, { method: M }>;
}
