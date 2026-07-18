import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCodingStorage } from '../storage/database/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createTestStorage() {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-artifact-'));
  roots.push(root);
  return createCodingStorage({
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
});
