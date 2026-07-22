/**
 * 本文件验证 server-file-service 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createArtifactFeature } from '../../src/features/artifact/index.js';
import { createFsFeature } from '../../src/features/fs/index.js';
import { parseClientParams } from '../../src/protocol/v1/index.js';
import { createTestPeer, invokeServiceRoute } from '../support/rpc.js';
import { createTestStores, type TestStores } from '../support/stores.js';

describe('Server 文件服务契约', () => {
  let previousHome: string | undefined;
  let root: string;
  let workspace: string;
  let storage: TestStores;
  let services: ReturnType<typeof createFileFeatures>;

  beforeEach(async () => {
    previousHome = process.env.ELLO_HOME;
    root = await mkdtemp(path.join(tmpdir(), 'ello-file-service-'));
    workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    process.env.ELLO_HOME = root;
    storage = createTestStores({
      databasePath: path.join(root, 'state.sqlite'),
      artifactsDir: path.join(root, 'artifacts'),
    });
    services = createFileFeatures(storage);
    await services.initialize();
  });

  afterEach(async () => {
    await services.close();
    storage.close();
    if (previousHome === undefined) delete process.env.ELLO_HOME;
    else process.env.ELLO_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  it('按完整 UTF-8 字符截断预览，并通过 Artifact 取回完整内容', async () => {
    const content = '甲乙丙';
    await writeFile(path.join(workspace, 'unicode.txt'), content, 'utf8');

    const response = (await invokeServiceRoute(
      services,
      connection(),
      'fs/readFile',
      {
        cwd: workspace,
        path: 'unicode.txt',
        maxBytes: 4,
      },
    )) as {
      readonly content: string;
      readonly byteCount: number;
      readonly truncated: boolean;
      readonly artifactId: string;
    };

    expect(response).toMatchObject({
      content: '甲',
      byteCount: Buffer.byteLength(content),
      truncated: true,
    });
    expect(response.content).not.toContain('\uFFFD');
    const artifact = (await invokeServiceRoute(
      services,
      connection(),
      'artifact/read',
      {
        artifactId: response.artifactId,
        offset: 0,
        maxBytes: 1024,
      },
    )) as { readonly content: string };
    expect(Buffer.from(artifact.content, 'base64').toString('utf8')).toBe(
      content,
    );
  });

  it('目录、元数据和搜索返回稳定的工作区内结果', async () => {
    await mkdir(path.join(workspace, 'src'));
    await writeFile(path.join(workspace, 'src', 'a.ts'), 'export {};\n');
    await writeFile(path.join(workspace, 'README.md'), 'readme\n');

    await expect(
      invokeServiceRoute(services, connection(), 'fs/readDirectory', {
        cwd: workspace,
        path: '.',
      }),
    ).resolves.toMatchObject({
      data: [
        { name: 'README.md', kind: 'file' },
        { name: 'src', kind: 'directory' },
      ],
    });
    await expect(
      invokeServiceRoute(services, connection(), 'fs/getMetadata', {
        cwd: workspace,
        path: 'src/a.ts',
      }),
    ).resolves.toMatchObject({ kind: 'file', size: 11 });
    await expect(
      invokeServiceRoute(services, connection(), 'fs/search', {
        cwd: workspace,
        query: 'a.ts',
        kind: 'file',
        limit: 10,
      }),
    ).resolves.toMatchObject({
      data: [{ name: 'a.ts', kind: 'file' }],
    });
  });

  it('拒绝词法路径穿越和指向工作区外的符号链接', async () => {
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'outside\n');
    await symlink(outside, path.join(workspace, 'outside-link.txt'));

    await expect(
      invokeServiceRoute(services, connection(), 'fs/readFile', {
        cwd: workspace,
        path: '../outside.txt',
      }),
    ).rejects.toMatchObject({ type: 'pathOutsideWorkspace' });
    await expect(
      invokeServiceRoute(services, connection(), 'fs/readFile', {
        cwd: workspace,
        path: 'outside-link.txt',
      }),
    ).rejects.toMatchObject({ type: 'pathOutsideWorkspace' });
  });

  it('拒绝非法 UTF-8、超大文件和超出 wire 上限的预览请求', async () => {
    await writeFile(path.join(workspace, 'binary.txt'), Buffer.from([0xff]));
    await writeFile(
      path.join(workspace, 'oversized.txt'),
      Buffer.alloc(8 * 1024 * 1024 + 1, 0x61),
    );

    await expect(
      invokeServiceRoute(services, connection(), 'fs/readFile', {
        cwd: workspace,
        path: 'binary.txt',
      }),
    ).rejects.toMatchObject({ type: 'invalidParams' });
    await expect(
      invokeServiceRoute(services, connection(), 'fs/readFile', {
        cwd: workspace,
        path: 'oversized.txt',
      }),
    ).rejects.toMatchObject({ type: 'invalidParams' });
    expect(() =>
      parseClientParams('fs/readFile', {
        cwd: workspace,
        path: 'unicode.txt',
        maxBytes: 1024 * 1024 + 1,
      }),
    ).toThrow();
  });
});

function connection() {
  return createTestPeer({ connectionId: 'connection-file-service' });
}

function createFileFeatures(storage: TestStores) {
  const artifacts = createArtifactFeature(storage.artifacts);
  const fs = createFsFeature(storage.artifacts);
  return {
    routes: { ...artifacts.routes, ...fs.routes },
    initialize: () => artifacts.initialize(),
    /**
     * 停止 测试夹具的 `server-file-service.test` 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
     *
     * Args:
     * - 无：操作使用实例或闭包已经持有的稳定状态。
     *
     * Returns:
     * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
     *
     * Throws:
     * - 当 测试夹具的 `server-file-service.test` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
     */
    async close(): Promise<void> {
      await fs.close();
      await artifacts.close();
    },
  };
}
