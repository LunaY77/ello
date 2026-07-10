import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentMessage } from '@ello/agent';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionCatalog } from '../session/catalog.js';
import { JsonlSessionStore } from '../session/jsonl-store.js';
import { JsonlSessionRepository } from '../session/repository.js';
import { createCodingStorage } from '../storage/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-session-storage-'));
  roots.push(root);
  const sessionDir = path.join(root, 'sessions');
  await mkdir(sessionDir, { recursive: true });
  const storage = createCodingStorage({
    databasePath: path.join(root, 'state.sqlite'),
    artifactsDir: path.join(root, 'artifacts'),
  });
  const store = new JsonlSessionStore({
    sessionDir,
    cwd: root,
    artifacts: storage.artifacts,
  });
  return { root, sessionDir, storage, store };
}

describe('session storage v3', () => {
  it('list 只读 catalog，不解析损坏的 transcript', async () => {
    const { root, sessionDir, storage, store } = await fixture();
    await store.load('session-1');
    await store.append('session-1', [{ role: 'user', content: 'hello' }]);
    await writeFile(
      path.join(sessionDir, 'session-1.jsonl'),
      '{ definitely not json',
      'utf8',
    );

    await expect(store.list()).resolves.toMatchObject([
      { sessionId: 'session-1', cwd: root, entryCount: 1 },
    ]);
    await expect(store.repository.load('session-1')).rejects.toThrow(
      'Invalid JSON',
    );
    storage.close();
  });

  it('replacement transform 只读内存快照，不回扫 session 文件', async () => {
    const { sessionDir, storage, store } = await fixture();
    await store.load('session-1');
    const artifact = await storage.artifacts.put({
      kind: 'tool-result',
      content: 'full output',
      contentType: 'text/plain; charset=utf-8',
      owner: {
        kind: 'tool-result',
        id: 'session-1:call-1',
        relation: 'full-output',
      },
    });
    await store.appendContentReplacement('session-1', {
      toolCallId: 'call-1',
      artifactId: artifact.id,
      preview: 'preview',
      originalBytes: artifact.byteSize,
      sha256: artifact.sha256,
    });
    await rename(
      path.join(sessionDir, 'session-1.jsonl'),
      path.join(sessionDir, 'session-1.moved'),
    );
    const messages: AgentMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read',
            output: { type: 'text', value: 'full output' },
          },
        ],
      },
    ];

    expect(
      JSON.stringify(store.applyContentReplacements('session-1', messages)),
    ).toContain('tool-output-truncated');
    storage.close();
  });

  it('加载 replacement snapshot 时发现 artifact 缺失会直接失败', async () => {
    const { root, sessionDir, storage, store } = await fixture();
    await store.load('session-1');
    const artifact = await storage.artifacts.put({
      kind: 'tool-result',
      content: 'full output',
      contentType: 'text/plain; charset=utf-8',
      owner: {
        kind: 'tool-result',
        id: 'session-1:call-1',
        relation: 'full-output',
      },
    });
    await store.appendContentReplacement('session-1', {
      toolCallId: 'call-1',
      artifactId: artifact.id,
      preview: 'preview',
      originalBytes: artifact.byteSize,
      sha256: artifact.sha256,
    });
    const row = storage.db.$client
      .prepare('select path from artifacts where id = ?')
      .get(artifact.id) as { readonly path: string };
    await rm(row.path);
    const reopened = new JsonlSessionStore({
      sessionDir,
      cwd: root,
      artifacts: storage.artifacts,
    });

    await expect(reopened.load('session-1')).rejects.toThrow('ENOENT');
    storage.close();
  });

  it('1000 个损坏历史文件仍可由 catalog 直接列出', async () => {
    const { root, sessionDir, storage, store } = await fixture();
    const catalog = new SessionCatalog(sessionDir);
    const records = Array.from({ length: 1_000 }, (_, index) => ({
      sessionId: `session-${index}`,
      cwd: root,
      path: path.join(sessionDir, `session-${index}.jsonl`),
      createdAt: '2026-01-01T00:00:00.000Z',
      messageCount: 1,
      lastUserText: `message-${index}`,
      updatedAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      sourceFileMtime: '2026-01-01T00:00:00.000Z',
    }));
    await Promise.all(
      records.map((record) => writeFile(record.path, 'not-json', 'utf8')),
    );
    await catalog.replace(records);

    await expect(store.list()).resolves.toHaveLength(1_000);
    storage.close();
  });

  it('显式 rebuild 遇到旧版本时直接失败', async () => {
    const { root, sessionDir, storage } = await fixture();
    await writeFile(
      path.join(sessionDir, 'v2.jsonl'),
      `${JSON.stringify({
        kind: 'header',
        sessionId: 'v2',
        cwd: root,
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 2,
      })}\n`,
      'utf8',
    );
    const repository = new JsonlSessionRepository({ sessionDir, cwd: root });

    await expect(repository.rebuildCatalog()).rejects.toThrow(
      'Invalid session record',
    );
    storage.close();
  });
});
