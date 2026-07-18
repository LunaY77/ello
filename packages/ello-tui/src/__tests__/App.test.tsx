import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ThreadSnapshot } from '../api/protocol-types.js';
import { ThreadClient } from '../client/thread-client.js';
import { App } from '../tui/App.js';

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

  it('profile role 与 active profile 使用各自的精确 global config path', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, '/profiles');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('main [active]'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Profile: main'));
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Select primary model for main'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('config/write', {
        cwd: '/workspace',
        source: 'global',
        path: ['profile', 'main', 'models', 'primary'],
        operation: 'set',
        value: 'mock/new',
      }),
    );
    await vi.waitFor(() => {
      expect(view.lastFrame()).not.toContain('Select primary model for main');
      expect(view.lastFrame()).toContain('Profile: main');
    });

    view.stdin.write('\u001b');
    await vi.waitFor(() =>
      expect(view.lastFrame()).not.toContain('Profile: main'),
    );
    await submitCommand(view, '/profiles');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('main [active]'));
    view.stdin.write('\u001b[B');
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/›\s+reviewer/u));
    view.stdin.write('f');
    await vi.waitFor(() => {
      expect(harness.request).toHaveBeenCalledWith('config/write', {
        cwd: '/workspace',
        source: 'global',
        path: ['active_profile'],
        operation: 'set',
        value: 'reviewer',
      });
      expect(harness.setProfile).not.toHaveBeenCalled();
      expect(view.lastFrame()).toContain('reviewer [active]');
    });
    view.unmount();
  });

  it('Hero 只显示一次 Server 返回的具体 settings', async () => {
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await vi.waitFor(() => expect(view.lastFrame()).toContain('profile: main'));
    expect(view.lastFrame()).toContain('model: mock/new');
    expect(view.lastFrame()).toContain('mode: ask-before-changes');
    expect(view.lastFrame()).not.toContain('profile: default');
    expect(view.lastFrame()).not.toContain('model: default');
    expect(view.lastFrame()?.match(/Ello Coding Agent/gu)).toHaveLength(1);
    await submitCommand(view, '/profiles');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('main [active]'));
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

  it('profile create/delete 使用 profile 叶节点，不覆盖整个配置', async () => {
    const createHarness = createThreadHarness(snapshot());
    const createView = render(<App thread={createHarness.thread} />);
    await waitForCatalogs(createHarness);
    await submitCommand(createView, '/profiles');
    await vi.waitFor(() =>
      expect(createView.lastFrame()).toContain('main [active]'),
    );
    createView.stdin.write('c');
    await vi.waitFor(() =>
      expect(createView.lastFrame()).toContain('Create profile'),
    );
    createView.stdin.write('new_profile');
    await vi.waitFor(() =>
      expect(createView.lastFrame()).toContain('Name: new_profile_'),
    );
    createView.stdin.write('\r');
    await vi.waitFor(() =>
      expect(createHarness.request).toHaveBeenCalledWith('config/write', {
        cwd: '/workspace',
        source: 'global',
        path: ['profile', 'new_profile'],
        operation: 'set',
        value: profileConfig().profile.main,
      }),
    );
    createView.unmount();

    const deleteHarness = createThreadHarness(snapshot());
    const deleteView = render(<App thread={deleteHarness.thread} />);
    await waitForCatalogs(deleteHarness);
    await submitCommand(deleteView, '/profiles');
    await vi.waitFor(() =>
      expect(deleteView.lastFrame()).toContain('reviewer'),
    );
    deleteView.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(selectedLine(deleteView.lastFrame(), 'reviewer')).toContain('›'),
    );
    deleteView.stdin.write('d');
    await vi.waitFor(() =>
      expect(deleteView.lastFrame()).toContain('Delete profile'),
    );
    deleteView.stdin.write('\r');
    await vi.waitFor(() =>
      expect(deleteHarness.request).toHaveBeenCalledWith('config/write', {
        cwd: '/workspace',
        source: 'global',
        path: ['profile', 'reviewer'],
        operation: 'delete',
      }),
    );
    deleteView.unmount();
  });

  it('/theme 把选择写入 Client 本地 tui.json', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-tui-app-'));
    roots.push(root);
    process.env.ELLO_HOME = root;
    const harness = createThreadHarness(snapshot());
    const view = render(<App thread={harness.thread} />);
    await waitForCatalogs(harness);

    await submitCommand(view, '/theme');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('github-dark'));
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
});

interface ThreadHarness {
  readonly thread: ThreadClient;
  readonly request: ReturnType<typeof vi.fn>;
  readonly fork: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly setProfile: ReturnType<typeof vi.fn>;
  readonly setMode: ReturnType<typeof vi.fn>;
}

function createThreadHarness(initialSnapshot: ThreadSnapshot): ThreadHarness {
  const config = profileConfig();
  const request = vi.fn(async (method: string) => {
    switch (method) {
      case 'model/list':
        return {
          data: [
            {
              id: 'mock/new',
              name: 'new',
              title: 'New model',
              enabled: true,
              metadata: { provider: 'mock' },
            },
          ],
        };
      case 'provider/list':
        return {
          data: [{ id: 'mock', name: 'Mock', enabled: true, metadata: {} }],
        };
      case 'skills/list':
      case 'agent/list':
      case 'task/list':
        return { data: [] };
      case 'config/read':
      case 'config/write':
        return { config };
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
      default:
        throw new Error(`Unexpected App test RPC ${method}.`);
    }
  });
  const fork = vi.fn();
  const close = vi.fn(async () => undefined);
  const setProfile = vi.fn(async () => undefined);
  const setMode = vi.fn(async () => undefined);
  const thread = {
    threadId: initialSnapshot.thread.id,
    cwd: initialSnapshot.thread.cwd,
    snapshot: initialSnapshot,
    subscribe: () => () => undefined,
    loadHistory: async () => undefined,
    request,
    fork,
    close,
    setProfile,
    setMode,
  } as unknown as ThreadClient;
  return { thread, request, fork, close, setProfile, setMode };
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
      profile: 'main',
      model: 'mock/new',
      agent: 'primary',
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

function profileConfig() {
  return {
    active_profile: 'main',
    initial_mode: 'ask-before-changes',
    bypass_enabled: true,
    profile: {
      main: {
        label: 'Main',
        models: {
          primary: 'mock/old',
          small: 'mock/old',
          compact: 'mock/old',
          title: 'mock/old',
          review: 'mock/old',
        },
      },
      reviewer: {
        label: 'Reviewer',
        models: {
          primary: 'mock/old',
          small: 'mock/old',
          compact: 'mock/old',
          title: 'mock/old',
          review: 'mock/old',
        },
      },
    },
  };
}

async function waitForCatalogs(harness: ThreadHarness): Promise<void> {
  await vi.waitFor(() =>
    expect(harness.request).toHaveBeenCalledWith('config/read', {
      cwd: '/workspace',
      includeSources: false,
    }),
  );
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
