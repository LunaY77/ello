/**
 * 本文件验证 artifact-store 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestStores } from '../support/stores.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createTestStorage() {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-artifact-'));
  roots.push(root);
  return createTestStores({
    databasePath: path.join(root, 'state.sqlite'),
    artifactsDir: path.join(root, 'artifacts'),
  });
}

describe('ArtifactStore', () => {
  it('按 sha256 去重，并在最后一个引用释放后删除文件', async () => {
    const storage = await createTestStorage();
    const firstOwner = {
      kind: 'checkpoint' as const,
      id: 'checkpoint-1',
      relation: 'before',
    };
    const secondOwner = {
      kind: 'tool-result' as const,
      id: 'session-1:call-1',
      relation: 'full-output',
    };
    const first = await storage.artifacts.put({
      kind: 'checkpoint',
      content: 'same content',
      contentType: 'text/plain; charset=utf-8',
      owner: firstOwner,
    });
    const second = await storage.artifacts.put({
      kind: 'tool-result',
      content: 'same content',
      contentType: 'text/plain; charset=utf-8',
      owner: secondOwner,
    });
    const row = storage.db.$client
      .prepare('select path from artifacts where id = ?')
      .get(first.id) as { readonly path: string };

    expect(second.id).toBe(first.id);
    expect(
      storage.db.$client
        .prepare('select count(*) as count from artifacts')
        .get(),
    ).toEqual({ count: 1 });
    expect(
      storage.db.$client
        .prepare('select count(*) as count from artifact_references')
        .get(),
    ).toEqual({ count: 2 });

    expect(await storage.artifacts.releaseOwner(firstOwner)).toEqual({
      deleted: 0,
      bytesFreed: 0,
    });
    await expect(access(row.path)).resolves.toBeUndefined();
    expect(await storage.artifacts.releaseOwner(secondOwner)).toEqual({
      deleted: 1,
      bytesFreed: Buffer.byteLength('same content'),
    });
    await expect(access(row.path)).rejects.toThrow();
    storage.close();
  });

  it('读取时校验 byte size 和 sha256', async () => {
    const storage = await createTestStorage();
    const artifact = await storage.artifacts.put({
      kind: 'tool-result',
      content: 'original',
      contentType: 'text/plain; charset=utf-8',
      owner: {
        kind: 'tool-result',
        id: 'session-1:call-1',
        relation: 'full-output',
      },
    });
    const row = storage.db.$client
      .prepare('select path from artifacts where id = ?')
      .get(artifact.id) as { readonly path: string };
    await writeFile(row.path, 'tampered', 'utf8');

    await expect(storage.artifacts.read(artifact.id)).rejects.toThrow(
      'sha256 mismatch',
    );
    expect(await readFile(row.path, 'utf8')).toBe('tampered');
    storage.close();
  });

  it('仅回收过期临时引用，checkpoint 引用不受保留期影响', async () => {
    const storage = await createTestStorage();
    const retained = await storage.artifacts.put({
      kind: 'checkpoint',
      content: 'retained',
      contentType: 'text/plain',
      owner: { kind: 'checkpoint', id: 'checkpoint-old', relation: 'before' },
    });
    const expired = await storage.artifacts.put({
      kind: 'shell-output',
      content: 'expired',
      contentType: 'text/plain',
      owner: { kind: 'tool-result', id: 'job-old', relation: 'output' },
    });
    storage.db.$client
      .prepare(
        "update artifact_references set created_at = '2000-01-01T00:00:00.000Z'",
      )
      .run();

    await expect(
      storage.artifacts.deleteExpiredReferences('2001-01-01T00:00:00.000Z'),
    ).resolves.toEqual({ deleted: 1, bytesFreed: 7 });
    await expect(storage.artifacts.read(retained.id)).resolves.toEqual(
      Buffer.from('retained'),
    );
    await expect(storage.artifacts.read(expired.id)).rejects.toThrow(
      'Unknown artifact',
    );
    storage.close();
  });

  it('重复写入同一 owner 会刷新临时引用保留期', async () => {
    const storage = await createTestStorage();
    const owner = {
      kind: 'tool-result' as const,
      id: 'job-renewed',
      relation: 'output',
    };
    const artifact = await storage.artifacts.put({
      kind: 'shell-output',
      content: 'renewed',
      contentType: 'text/plain',
      owner,
    });
    storage.db.$client
      .prepare(
        "update artifact_references set created_at = '2000-01-01T00:00:00.000Z'",
      )
      .run();
    await storage.artifacts.put({
      kind: 'shell-output',
      content: 'renewed',
      contentType: 'text/plain',
      owner,
    });

    await expect(
      storage.artifacts.deleteExpiredReferences('2001-01-01T00:00:00.000Z'),
    ).resolves.toEqual({ deleted: 0, bytesFreed: 0 });
    await expect(storage.artifacts.read(artifact.id)).resolves.toEqual(
      Buffer.from('renewed'),
    );
    storage.close();
  });
});
