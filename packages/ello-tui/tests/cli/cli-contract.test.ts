import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppServerClient } from '../../src/api/client.js';
import type {
  ServerNotification,
  ThreadSnapshot,
} from '../../src/api/protocol-types.js';

const mocks = vi.hoisted(() => ({
  connectClient: vi.fn(),
  renderTui: vi.fn(),
  runAppServer: vi.fn(),
}));

vi.mock('../../src/client/connection.js', () => ({
  connectClient: mocks.connectClient,
}));
vi.mock('../../src/tui/index.js', () => ({ renderTui: mocks.renderTui }));
vi.mock('../../src/cli/server-launcher.js', () => ({
  runAppServer: mocks.runAppServer,
}));

describe('CLI contract', () => {
  let stdout: string[];
  const temporaryRoots: string[] = [];

  beforeEach(() => {
    stdout = [];
    vi.resetModules();
    mocks.connectClient.mockReset();
    mocks.renderTui.mockReset();
    mocks.runAppServer.mockReset();
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    delete process.env.ELLO_CLI_TEST_TOKEN;
    vi.restoreAllMocks();
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('非交互 help 不建立连接', async () => {
    const { runCli } = await import('../../src/cli/main.js');

    await runCli(['node', 'ello']);

    expect(stdout.join('')).toContain('Ello JSON-RPC client');
    expect(mocks.connectClient).not.toHaveBeenCalled();
  });

  it('remote 连接只透传 endpoint 和显式环境变量 token', async () => {
    process.env.ELLO_CLI_TEST_TOKEN = 'remote-secret';
    const client = managementClient({ data: [] });
    mocks.connectClient.mockResolvedValue(connection(client));
    const { runCli } = await import('../../src/cli/main.js');

    await runCli([
      'node',
      'ello',
      '--remote',
      'wss://agent.example.test/rpc',
      '--remote-auth-token-env',
      'ELLO_CLI_TEST_TOKEN',
      '--json',
      'sessions',
    ]);

    expect(mocks.connectClient).toHaveBeenCalledWith({
      endpoint: 'wss://agent.example.test/rpc',
      authToken: 'remote-secret',
    });
    expect(client.request).toHaveBeenCalledWith('thread/list', {
      archived: false,
      cwd: process.cwd(),
      limit: 50,
    });
    expect(client.close).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout.join(''))).toEqual({ data: [] });
  });

  it('缺少 remote token 时在连接前明确失败', async () => {
    const { runCli } = await import('../../src/cli/main.js');

    await expect(
      runCli([
        'node',
        'ello',
        '--remote',
        'ws://127.0.0.1:9810',
        '--remote-auth-token-env',
        'ELLO_CLI_TEST_TOKEN',
        'sessions',
      ]),
    ).rejects.toThrow(
      'Authentication token environment variable ELLO_CLI_TEST_TOKEN is empty',
    );
    expect(mocks.connectClient).not.toHaveBeenCalled();
  });

  it('sessions 默认按当前目录列出归档 Thread', async () => {
    const client = managementClient({ data: [] });
    mocks.connectClient.mockResolvedValue(connection(client));
    const { runCli } = await import('../../src/cli/main.js');

    await runCli([
      'node',
      'ello',
      '--root',
      '/workspace/current',
      '--json',
      'sessions',
      '--archived',
    ]);

    expect(client.request).toHaveBeenCalledWith('thread/list', {
      archived: true,
      cwd: '/workspace/current',
      limit: 50,
    });
  });

  it('sessions --all 显式省略 cwd，并可与 --archived 组合', async () => {
    const client = managementClient({ data: [] });
    mocks.connectClient.mockResolvedValue(connection(client));
    const { runCli } = await import('../../src/cli/main.js');

    await runCli([
      'node',
      'ello',
      '--root',
      '/workspace/current',
      '--json',
      'sessions',
      '--all',
      '--archived',
    ]);

    expect(client.request).toHaveBeenCalledWith('thread/list', {
      archived: true,
      limit: 50,
    });
  });

  it('resume 无 ID 时只选择当前 cwd 最近的未归档 Thread', async () => {
    const client = resumeClient();
    mocks.connectClient.mockResolvedValue({ client });
    const { runCli } = await import('../../src/cli/main.js');

    await runCli([
      'node',
      'ello',
      '--root',
      '/workspace/current',
      '--json',
      'resume',
    ]);

    expect(client.request).toHaveBeenNthCalledWith(1, 'thread/list', {
      archived: false,
      cwd: '/workspace/current',
      limit: 1,
    });
    expect(client.request).toHaveBeenNthCalledWith(2, 'thread/resume', {
      threadId: 'thr_cli',
      subscribe: true,
    });
  });

  it('resume --all 从全局选择最近 Thread，显式 ID 不执行列表查询', async () => {
    const allClient = resumeClient();
    mocks.connectClient.mockResolvedValue({ client: allClient });
    const { runCli } = await import('../../src/cli/main.js');

    await runCli(['node', 'ello', '--json', 'resume', '--all']);

    expect(allClient.request).toHaveBeenNthCalledWith(1, 'thread/list', {
      archived: false,
      limit: 1,
    });

    vi.resetModules();
    const explicitClient = resumeClient();
    mocks.connectClient.mockResolvedValue({ client: explicitClient });
    const explicitCli = await import('../../src/cli/main.js');
    await explicitCli.runCli([
      'node',
      'ello',
      '--json',
      'resume',
      'thr_explicit',
    ]);

    expect(explicitClient.request).toHaveBeenCalledOnce();
    expect(explicitClient.request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thr_explicit',
      subscribe: true,
    });
  });

  it('thread help 暴露正式 archive 和 unarchive 子命令', async () => {
    const { runCli } = await import('../../src/cli/main.js');
    vi.spyOn(process, 'exit').mockImplementation((code): never => {
      throw new Error(`process.exit ${String(code)}`);
    });

    await expect(runCli(['node', 'ello', 'thread', '--help'])).rejects.toThrow(
      'process.exit 0',
    );

    const help = stdout.join('');
    expect(help).toMatch(/archive \[options\] <threadId>/u);
    expect(help).toMatch(/unarchive \[options\] <threadId>/u);
    expect(mocks.connectClient).not.toHaveBeenCalled();
  });

  it('thread archive 使用文本输出，unarchive 使用 JSON 输出', async () => {
    const archived = {
      ...snapshot().thread,
      archived: true,
    };
    const archiveClient = managementClient({ thread: archived });
    mocks.connectClient.mockResolvedValue(connection(archiveClient));
    const { runCli } = await import('../../src/cli/main.js');

    await runCli(['node', 'ello', 'thread', 'archive', 'thr_cli']);

    expect(archiveClient.request).toHaveBeenCalledWith('thread/archive', {
      threadId: 'thr_cli',
    });
    expect(stdout.join('')).toContain('"archived": true');

    stdout = [];
    vi.resetModules();
    const unarchived = { ...archived, archived: false };
    const unarchiveClient = managementClient({ thread: unarchived });
    mocks.connectClient.mockResolvedValue(connection(unarchiveClient));
    const unarchiveCli = await import('../../src/cli/main.js');
    await unarchiveCli.runCli([
      'node',
      'ello',
      '--json',
      'thread',
      'unarchive',
      'thr_cli',
    ]);

    expect(unarchiveClient.request).toHaveBeenCalledWith('thread/unarchive', {
      threadId: 'thr_cli',
    });
    expect(JSON.parse(stdout.join(''))).toEqual({ thread: unarchived });
  });

  it('一次性 JSON run 只输出可解析通知，并发送结构化输入', async () => {
    const client = runClient('completed');
    mocks.connectClient.mockResolvedValue(connection(client));
    const { runCli } = await import('../../src/cli/main.js');

    await runCli([
      'node',
      'ello',
      '--json',
      '--no-tui',
      'run',
      'hello',
      'ello',
    ]);

    expect(client.request).toHaveBeenNthCalledWith(1, 'thread/start', {
      cwd: process.cwd(),
      subscribe: true,
    });
    expect(client.request).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thr_cli',
      input: [{ type: 'text', text: 'hello ello' }],
    });
    const output = stdout
      .filter((chunk) => chunk.trim() !== '')
      .map((chunk) => JSON.parse(chunk));
    expect(output).toEqual([
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({ turnId: 'turn_cli' }),
      }),
    ]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('一次性 run 收到 failed 终态后立即失败并保留 Server 错误', async () => {
    const client = runClient('failed');
    mocks.connectClient.mockResolvedValue(connection(client));
    const { runCli } = await import('../../src/cli/main.js');

    await expect(
      runCli(['node', 'ello', '--no-tui', 'run', 'trigger', 'failure']),
    ).rejects.toThrow(
      'Turn turn_cli failed (MODEL_ERROR: provider unavailable).',
    );
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('一次性 run 收到 interrupted 终态后以明确中断语义退出', async () => {
    const client = runClient('interrupted');
    mocks.connectClient.mockResolvedValue(connection(client));
    const { runCli } = await import('../../src/cli/main.js');

    await expect(
      runCli(['node', 'ello', '--no-tui', 'run', 'interrupt', 'me']),
    ).rejects.toThrow('Turn turn_cli was interrupted.');
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('非交互 run 拒绝空 prompt，且不启动 Server', async () => {
    const { runCli } = await import('../../src/cli/main.js');

    await expect(runCli(['node', 'ello', '--no-tui', 'run'])).rejects.toThrow(
      'run requires a prompt in non-interactive mode',
    );
    expect(mocks.connectClient).not.toHaveBeenCalled();
  });

  it('管理命令映射到 typed RPC，并保留 Server 错误对象', async () => {
    const serverError = Object.assign(new Error('permission denied'), {
      code: -32_003,
    });
    const client = managementClient(serverError, true);
    mocks.connectClient.mockResolvedValue(connection(client));
    const { runCli } = await import('../../src/cli/main.js');

    await expect(
      runCli([
        'node',
        'ello',
        '--root',
        '/workspace/project',
        '--json',
        'config',
        'read',
      ]),
    ).rejects.toBe(serverError);

    expect(client.request).toHaveBeenCalledWith('config/read', {
      cwd: '/workspace/project',
      includeSources: true,
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('已移除的管理操作明确失败，不回退访问本地存储', async () => {
    const { runCli } = await import('../../src/cli/main.js');

    await expect(
      runCli(['node', 'ello', 'config', 'legacy-read']),
    ).rejects.toThrow('Unsupported config operation legacy-read');
    expect(mocks.connectClient).not.toHaveBeenCalled();
  });

  it('workspace 支持 ws alias，并将 repo add 映射到 workspace RPC', async () => {
    const client = managementClient({
      workspace: {
        id: 'ws_fixture',
        kind: 'refactor',
        name: 'ello',
        rootPath: '/workspace/refactor/ello',
        status: 'active',
        branch: 'refactor/ello',
        repositories: [],
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
      },
    });
    mocks.connectClient.mockResolvedValue(connection(client));
    const { runCli } = await import('../../src/cli/main.js');

    await runCli([
      'node',
      'ello',
      '--json',
      'ws',
      'repo',
      'add',
      'ccb/claude-code',
      '--workspace',
      'refactor/ello',
      '--detached',
    ]);

    expect(client.request).toHaveBeenCalledWith('workspace/repo/add', {
      workspace: 'refactor/ello',
      repo: 'ccb/claude-code',
      role: 'reference',
      detached: true,
    });
  });

  it('repository registry 命令由 Workspace 领域注册并调用 repo RPC', async () => {
    const client = managementClient({ data: [] });
    mocks.connectClient.mockResolvedValue(connection(client));
    const { runCli } = await import('../../src/cli/main.js');

    await runCli(['node', 'ello', '--json', 'repo', 'list']);

    expect(client.request).toHaveBeenCalledWith('repo/list', {});
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('repo help 暴露完整 registry、remote 和 portability 命令', async () => {
    const { runCli } = await import('../../src/cli/main.js');
    vi.spyOn(process, 'exit').mockImplementation((code): never => {
      throw new Error(`process.exit ${String(code)}`);
    });

    await expect(runCli(['node', 'ello', 'repo', '--help'])).rejects.toThrow(
      'process.exit 0',
    );

    const help = stdout.join('');
    for (const command of [
      'add',
      'list',
      'show',
      'rename',
      'remove',
      'fetch',
      'fetch-local',
      'remote',
      'export',
      'import',
    ]) {
      expect(help).toContain(command);
    }
    expect(mocks.connectClient).not.toHaveBeenCalled();
  });

  it('repo add 支持 local-only，并只在显式提供时发送 remoteUrl', async () => {
    const client = managementClient({ repository: { key: 'ello' } });
    mocks.connectClient.mockResolvedValue(connection(client));
    const { runCli } = await import('../../src/cli/main.js');

    await runCli([
      'node',
      'ello',
      '--json',
      'repo',
      'add',
      'ello',
      '/workspace/ello',
    ]);

    expect(client.request).toHaveBeenCalledWith('repo/add', {
      key: 'ello',
      source: '/workspace/ello',
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('repo import 严格读取 JSON document 后调用 typed RPC', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-cli-repo-import-'));
    temporaryRoots.push(root);
    const file = path.join(root, 'repos.json');
    const document = {
      formatVersion: 1,
      exportedAt: '2026-07-22T00:00:00.000Z',
      repositories: [],
    };
    await writeFile(file, JSON.stringify(document), 'utf8');
    const client = managementClient({ data: [] });
    mocks.connectClient.mockResolvedValue(connection(client));
    const { runCli } = await import('../../src/cli/main.js');

    await runCli(['node', 'ello', '--json', 'repo', 'import', file]);

    expect(client.request).toHaveBeenCalledWith('repo/import', { document });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('repo export 直接输出可被 repo import 消费的 document', async () => {
    const document = {
      formatVersion: 1,
      exportedAt: '2026-07-22T00:00:00.000Z',
      repositories: [],
    };
    const client = managementClient({ document });
    mocks.connectClient.mockResolvedValue(connection(client));
    const { runCli } = await import('../../src/cli/main.js');

    await runCli(['node', 'ello', '--json', 'repo', 'export', 'web', 'api']);

    expect(client.request).toHaveBeenCalledWith('repo/export', {
      repos: ['web', 'api'],
    });
    expect(JSON.parse(stdout.join(''))).toEqual(document);
    expect(client.close).toHaveBeenCalledOnce();
  });
});

function managementClient(result: unknown, rejects = false) {
  return {
    request: rejects
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result),
    close: vi.fn().mockResolvedValue(undefined),
    onNotification: vi.fn(() => () => undefined),
    onServerRequest: vi.fn(() => () => undefined),
  };
}

function resumeClient() {
  return {
    request: vi.fn(async (method: string, params: unknown) => {
      if (method === 'thread/list') return { data: [snapshot().thread] };
      if (method === 'thread/resume') {
        const threadId = (params as { threadId: string }).threadId;
        const result = snapshot();
        return {
          ...result,
          thread: { ...result.thread, id: threadId, rootId: threadId },
        };
      }
      throw new Error(`Unexpected resume request: ${method}`);
    }),
    close: vi.fn().mockResolvedValue(undefined),
    onNotification: vi.fn(() => () => undefined),
    onServerRequest: vi.fn(() => () => undefined),
  };
}

function runClient(terminalStatus: 'completed' | 'failed' | 'interrupted') {
  const notificationListeners = new Set<
    (notification: ServerNotification) => void
  >();
  let turnStarted = false;
  let completionQueued = false;
  const request = vi.fn(async (method: string) => {
    if (method === 'thread/start') return snapshot();
    if (method === 'turn/start') {
      turnStarted = true;
      return { turn: completedTurn('inProgress') };
    }
    throw new Error(`Unexpected CLI request: ${method}`);
  });
  const client = {
    request,
    close: vi.fn().mockResolvedValue(undefined),
    onServerRequest: vi.fn(() => () => undefined),
    onNotification: vi.fn(
      (listener: (notification: ServerNotification) => void) => {
        notificationListeners.add(listener);
        if (turnStarted && !completionQueued) {
          completionQueued = true;
          queueMicrotask(() => {
            const notification: ServerNotification = {
              method: 'turn/completed',
              params: {
                threadId: 'thr_cli',
                turnId: 'turn_cli',
                seq: 2,
                turn: terminalTurn(terminalStatus),
              },
            };
            for (const current of notificationListeners) current(notification);
          });
        }
        return () => notificationListeners.delete(listener);
      },
    ),
  };
  return client;
}

function connection(
  client: ReturnType<typeof managementClient> | ReturnType<typeof runClient>,
) {
  return { client: client as unknown as AppServerClient };
}

function snapshot(): ThreadSnapshot {
  return {
    thread: {
      id: 'thr_cli',
      rootId: 'thr_cli',
      cwd: '/workspace',
      name: 'CLI thread',
      preview: '',
      status: 'idle',
      archived: false,
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    },
    settings: {
      mode: 'ask-before-changes',
      profile: 'main',
      model: 'mock/model',
      agent: 'build',
    },
    turns: [],
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
    seq: 1,
  };
}

function completedTurn(status: 'inProgress' | 'completed') {
  return {
    id: 'turn_cli',
    threadId: 'thr_cli',
    status,
    items: [],
    startedAt: '2026-07-19T00:00:00.000Z',
    ...(status === 'completed'
      ? { completedAt: '2026-07-19T00:00:01.000Z' }
      : {}),
  };
}

function terminalTurn(status: 'completed' | 'failed' | 'interrupted') {
  const base = {
    id: 'turn_cli',
    threadId: 'thr_cli',
    status,
    items: [],
    startedAt: '2026-07-19T00:00:00.000Z',
    completedAt: '2026-07-19T00:00:01.000Z',
  };
  if (status !== 'failed') return base;
  return {
    ...base,
    errorCode: 'MODEL_ERROR',
    items: [
      {
        id: 'item_cli_error',
        turnId: 'turn_cli',
        type: 'error' as const,
        status: 'failed' as const,
        code: 'MODEL_ERROR',
        message: 'provider unavailable',
        createdAt: '2026-07-19T00:00:01.000Z',
        completedAt: '2026-07-19T00:00:01.000Z',
      },
    ],
  };
}
