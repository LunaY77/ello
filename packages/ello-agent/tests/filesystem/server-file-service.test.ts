import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseClientParams } from '../../src/protocol/v1/index.js';
import type { ServerConnection } from '../../src/server/connection/server-connection.js';
import { ServerServices } from '../../src/server/methods/server-services.js';
import type { ThreadManager } from '../../src/server/runtime/thread-manager.js';
import {
  createCodingStorage,
  type CodingStorage,
} from '../../src/storage/database/index.js';
import type { ThreadLogRepository } from '../../src/storage/threads/thread-log.js';

describe('Server 文件服务契约', () => {
  let previousHome: string | undefined;
  let root: string;
  let workspace: string;
  let storage: CodingStorage;
  let services: ServerServices;

  beforeEach(async () => {
    previousHome = process.env.ELLO_HOME;
    root = await mkdtemp(path.join(tmpdir(), 'ello-file-service-'));
    workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    process.env.ELLO_HOME = root;
    storage = createCodingStorage({
      databasePath: path.join(root, 'state.sqlite'),
      artifactsDir: path.join(root, 'artifacts'),
    });
    services = new ServerServices({
      storage,
      threads: {} as ThreadManager,
      logs: {} as ThreadLogRepository,
    });
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

    const response = (await services.dispatch(connection(), 'fs/readFile', {
      cwd: workspace,
      path: 'unicode.txt',
      maxBytes: 4,
    })) as {
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
    const artifact = (await services.dispatch(connection(), 'artifact/read', {
      artifactId: response.artifactId,
      offset: 0,
      maxBytes: 1024,
    })) as { readonly content: string };
    expect(Buffer.from(artifact.content, 'base64').toString('utf8')).toBe(
      content,
    );
  });

  it('目录、元数据和搜索返回稳定的工作区内结果', async () => {
    await mkdir(path.join(workspace, 'src'));
    await writeFile(path.join(workspace, 'src', 'a.ts'), 'export {};\n');
    await writeFile(path.join(workspace, 'README.md'), 'readme\n');

    await expect(
      services.dispatch(connection(), 'fs/readDirectory', {
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
      services.dispatch(connection(), 'fs/getMetadata', {
        cwd: workspace,
        path: 'src/a.ts',
      }),
    ).resolves.toMatchObject({ kind: 'file', size: 11 });
    await expect(
      services.dispatch(connection(), 'fs/search', {
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
      services.dispatch(connection(), 'fs/readFile', {
        cwd: workspace,
        path: '../outside.txt',
      }),
    ).rejects.toMatchObject({ type: 'pathOutsideWorkspace' });
    await expect(
      services.dispatch(connection(), 'fs/readFile', {
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
      services.dispatch(connection(), 'fs/readFile', {
        cwd: workspace,
        path: 'binary.txt',
      }),
    ).rejects.toMatchObject({ type: 'invalidParams' });
    await expect(
      services.dispatch(connection(), 'fs/readFile', {
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

function connection(): ServerConnection {
  return { id: 'connection-file-service' } as ServerConnection;
}
