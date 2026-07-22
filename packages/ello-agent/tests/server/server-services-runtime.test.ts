/**
 * 本文件验证 server-services-runtime 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ThreadFeature,
  ThreadStore,
} from '../../src/features/thread/index.js';
import {
  RepoStore,
  REPOSITORY_BASELINE_REF,
} from '../../src/features/workspace/index.js';
import type { ThreadSnapshot } from '../../src/protocol/v1/index.js';
import { createTestFeatures } from '../support/features.js';
import { createTestPeer, invokeServiceRoute } from '../support/rpc.js';
import { createTestStores, type TestStores } from '../support/stores.js';

const execFileAsync = promisify(execFile);

describe('ServerServices runtime contracts', () => {
  let oldHome: string | undefined;
  let home: string;
  const roots: string[] = [];
  const storages: TestStores[] = [];
  const services: Array<ReturnType<typeof createTestFeatures>> = [];

  beforeEach(async () => {
    oldHome = process.env.ELLO_HOME;
    home = await temporaryRoot('ello-server-services-');
    process.env.ELLO_HOME = home;
  });

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    for (const storage of storages.splice(0)) storage.close();
    if (oldHome === undefined) delete process.env.ELLO_HOME;
    else process.env.ELLO_HOME = oldHome;
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('超大 Shell 输出只内联预览，并可通过 artifact/read 分块取回原文', async () => {
    const storage = createStorage(home);
    const service = createService(storage, threadSnapshot(home));
    const fullOutput = 'x'.repeat(300_000);
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      `process.stdout.write('x'.repeat(${fullOutput.length}))`,
    )}`;

    const shell = (await invokeServiceRoute(
      service,
      connection('connection-shell'),
      'thread/shellCommand',
      { threadId: 'thr_runtime', command, timeoutMs: 10_000 },
    )) as {
      readonly stdout: string;
      readonly stderr: string;
      readonly artifactId?: string;
    };
    expect(Buffer.byteLength(shell.stdout)).toBeLessThanOrEqual(128 * 1024);
    expect(shell.stdout.length).toBeLessThan(fullOutput.length);
    expect(shell.stderr).toBe('');
    expect(shell.artifactId).toBeDefined();

    const artifact = (await invokeServiceRoute(
      service,
      connection('connection-shell'),
      'artifact/read',
      {
        artifactId: shell.artifactId!,
        offset: 0,
        maxBytes: 1024 * 1024,
      },
    )) as {
      readonly content: string;
      readonly encoding: 'base64';
      readonly byteCount: number;
      readonly eof: boolean;
    };
    expect(artifact.encoding).toBe('base64');
    expect(artifact.byteCount).toBe(fullOutput.length);
    expect(artifact.eof).toBe(true);
    expect(Buffer.from(artifact.content, 'base64').toString('utf8')).toBe(
      fullOutput,
    );
  });

  it('watch 只能由创建连接释放，连接关闭会自动清理', async () => {
    await writeFile(path.join(home, 'watched.txt'), 'initial\n', 'utf8');
    const storage = createStorage(home);
    const service = createService(storage, threadSnapshot(home));
    const owner = connection('connection-owner');
    const other = connection('connection-other');
    const result = (await invokeServiceRoute(service, owner, 'fs/watch', {
      cwd: home,
      paths: ['watched.txt'],
    })) as { readonly watchId: string };

    await expect(
      invokeServiceRoute(service, other, 'fs/unwatch', {
        watchId: result.watchId,
      }),
    ).rejects.toMatchObject({ type: 'invalidParams' });
    service.releaseConnection(owner.connectionId);
    await expect(
      invokeServiceRoute(service, owner, 'fs/unwatch', {
        watchId: result.watchId,
      }),
    ).rejects.toMatchObject({ type: 'invalidParams' });
  });

  it('未装配 delegation runner 的 Subagent 在目录中明确标记不可用', async () => {
    const storage = createStorage(home);
    const service = createService(storage, threadSnapshot(home));
    const response = (await invokeServiceRoute(
      service,
      connection('connection-agent-catalog'),
      'agent/list',
      { cwd: home },
    )) as {
      readonly data: readonly {
        readonly enabled: boolean;
        readonly metadata: Record<string, unknown>;
      }[];
    };
    const unavailable = response.data.filter(
      (agent) => agent.metadata.mode === 'subagent',
    );

    expect(unavailable.length).toBeGreaterThan(0);
    expect(unavailable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          enabled: false,
          metadata: expect.objectContaining({
            runtime: 'unavailable:no-delegation-runner',
          }),
        }),
      ]),
    );
  });

  it('local-only repo 通过 RPC bundle 在新 Server root 完整往返', async () => {
    const source = path.join(home, 'source');
    await initializeRepository(source);
    const sourceStorage = createStorage(home);
    const sourceService = createService(sourceStorage, threadSnapshot(home));
    await invokeServiceRoute(
      sourceService,
      connection('connection-export'),
      'repo/add',
      { key: 'portable', source },
    );
    const exported = (await invokeServiceRoute(
      sourceService,
      connection('connection-export'),
      'repo/export',
      { repos: ['portable'] },
    )) as {
      readonly document: {
        readonly repositories: readonly {
          readonly key: string;
          readonly remoteUrl: string | null;
          readonly defaultBranch: string;
          readonly bundle?: {
            readonly encoding: string;
            readonly data: string;
          };
        }[];
      };
    };
    expect(exported.document.repositories[0]).toMatchObject({
      remoteUrl: null,
      bundle: { encoding: 'base64' },
    });

    const importedHome = await temporaryRoot('ello-server-import-');
    process.env.ELLO_HOME = importedHome;
    const importedStorage = createStorage(importedHome);
    const importedService = createService(
      importedStorage,
      threadSnapshot(importedHome),
    );
    const portable = exported.document.repositories[0]!;
    await expect(
      invokeServiceRoute(
        importedService,
        connection('connection-import'),
        'repo/import',
        {
          document: {
            ...exported.document,
            repositories: [
              { ...portable, key: 'first' },
              {
                ...portable,
                key: 'broken',
                bundle: {
                  encoding: 'base64',
                  data: Buffer.from('not a git bundle').toString('base64'),
                },
              },
            ],
          },
        },
      ),
    ).rejects.toThrow();
    expect(new RepoStore(importedStorage.repositories).list()).toEqual([]);

    await expect(
      invokeServiceRoute(
        importedService,
        connection('connection-import'),
        'repo/import',
        {
          document: exported.document,
        },
      ),
    ).resolves.toMatchObject({
      data: [{ key: 'portable', sourceUrl: null }],
    });
    const imported = new RepoStore(importedStorage.repositories).show(
      'portable',
    );
    expect(imported?.remoteUrl).toBeNull();
    await expect(
      execFileAsync('git', [
        '-C',
        imported!.mirrorPath,
        'rev-parse',
        '--verify',
        REPOSITORY_BASELINE_REF,
      ]),
    ).resolves.toMatchObject({
      stdout: expect.stringMatching(/^[0-9a-f]+\n$/u),
    });
  });

  function createStorage(root: string): TestStores {
    const storage = createTestStores({
      databasePath: path.join(root, 'state', 'ello.sqlite'),
      artifactsDir: path.join(root, 'artifacts'),
    });
    storages.push(storage);
    return storage;
  }

  function createService(
    storage: TestStores,
    snapshot: ThreadSnapshot,
  ): ReturnType<typeof createTestFeatures> {
    const service = createTestFeatures({
      storage,
      threads: {
        read: () => Promise.resolve(snapshot),
      } as unknown as ThreadFeature,
      store: {} as ThreadStore,
      compact: () => Promise.reject(new Error('Unexpected compact request.')),
    });
    services.push(service);
    return service;
  }

  async function temporaryRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }
});

function connection(id: string) {
  return createTestPeer({ connectionId: id });
}

function threadSnapshot(cwd: string): ThreadSnapshot {
  return {
    thread: {
      id: 'thr_runtime',
      rootId: 'thr_runtime',
      cwd,
      name: 'runtime',
      preview: '',
      status: 'idle',
      archived: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    settings: {
      mode: 'ask-before-changes',
      profile: 'test',
      model: 'test:model',
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

async function initializeRepository(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await execFileAsync('git', ['init', '--initial-branch', 'main', root]);
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'ello@test']);
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Ello Test']);
  await writeFile(path.join(root, 'README.md'), 'portable\n', 'utf8');
  await execFileAsync('git', ['-C', root, 'add', '.']);
  await execFileAsync('git', ['-C', root, 'commit', '-m', 'initial']);
}
