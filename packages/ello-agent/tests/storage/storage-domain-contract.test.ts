import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CheckpointStore } from '../../src/agent/change/checkpoint.js';
import { recordCheckpointChanges } from '../../src/agent/change/recording.js';
import {
  createCodingStorage,
  type CodingStorage,
} from '../../src/storage/database/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTestStorage(): Promise<{
  readonly root: string;
  readonly storage: CodingStorage;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-storage-contract-'));
  temporaryDirectories.push(root);
  return {
    root,
    storage: createCodingStorage({
      databasePath: path.join(root, 'state.sqlite'),
      artifactsDir: path.join(root, 'artifacts'),
    }),
  };
}

describe('Checkpoint 领域契约', () => {
  it('空变更不创建检查点或 artifact', async () => {
    const { storage } = await createTestStorage();
    try {
      await expect(
        storage.checkpoints.seal({ runId: 'empty', changes: [] }),
      ).resolves.toBeNull();
      expect(await storage.checkpoints.list()).toEqual([]);
      expect(
        storage.db.$client
          .prepare('select count(*) as count from artifacts')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      storage.close();
    }
  });

  it('封存新增、修改和删除内容并可从内容寻址 artifact 完整恢复', async () => {
    const { root, storage } = await createTestStorage();
    try {
      const checkpoint = await storage.checkpoints.seal({
        runId: 'run-1',
        label: '批量编辑',
        changes: [
          {
            path: path.join(root, 'created.txt'),
            before: null,
            after: 'created\n',
            toolCallId: 'call-create',
            diff: 'create diff',
          },
          {
            path: path.join(root, 'updated.txt'),
            before: 'before\n',
            after: 'after\n',
            toolCallId: 'call-update',
            diff: 'update diff',
          },
          {
            path: path.join(root, 'deleted.txt'),
            before: 'deleted\n',
            after: null,
            toolCallId: 'call-delete',
            diff: 'delete diff',
          },
        ],
      });

      expect(checkpoint).toMatchObject({
        runId: 'run-1',
        label: '批量编辑',
        changes: [
          { before: null, after: 'created\n' },
          { before: 'before\n', after: 'after\n' },
          { before: 'deleted\n', after: null },
        ],
      });
      expect(await storage.checkpoints.detail(checkpoint!.id)).toEqual(
        checkpoint,
      );
      expect(await storage.checkpoints.list()).toEqual([checkpoint]);
      expect(
        storage.db.$client
          .prepare('select count(*) as count from artifact_references')
          .get(),
      ).toEqual({ count: 4 });
    } finally {
      storage.close();
    }
  });

  it('回滚按逆序恢复 before 内容并记录成功终态', async () => {
    const { root, storage } = await createTestStorage();
    try {
      const createdPath = path.join(root, 'created.txt');
      const updatedPath = path.join(root, 'updated.txt');
      const deletedPath = path.join(root, 'nested', 'deleted.txt');
      await writeFile(createdPath, 'created\n', 'utf8');
      await writeFile(updatedPath, 'after\n', 'utf8');
      const store = new CheckpointStore(storage.checkpoints);
      store.record({
        path: createdPath,
        before: null,
        after: 'created\n',
        toolCallId: 'call-create',
        diff: 'create',
      });
      store.record({
        path: updatedPath,
        before: 'before\n',
        after: 'after\n',
        toolCallId: 'call-update',
        diff: 'update',
      });
      store.record({
        path: deletedPath,
        before: 'deleted\n',
        after: null,
        toolCallId: 'call-delete',
        diff: 'delete',
      });
      const checkpoint = await store.seal('run-rollback', '回滚验证');

      await expect(store.rollback(checkpoint!.id)).resolves.toHaveLength(3);
      await expect(readFile(createdPath, 'utf8')).rejects.toThrow();
      await expect(readFile(updatedPath, 'utf8')).resolves.toBe('before\n');
      await expect(readFile(deletedPath, 'utf8')).resolves.toBe('deleted\n');
      expect(
        storage.db.$client
          .prepare('select status from checkpoints where id = ?')
          .get(checkpoint!.id),
      ).toEqual({ status: 'rolled_back' });
      expect(
        storage.db.$client
          .prepare(
            'select status, error_message as errorMessage from checkpoint_rollbacks where checkpoint_id = ?',
          )
          .get(checkpoint!.id),
      ).toEqual({ status: 'completed', errorMessage: null });
    } finally {
      storage.close();
    }
  });

  it('回滚前发现文件漂移时不修改任何文件并记录失败终态', async () => {
    const { root, storage } = await createTestStorage();
    const createdPath = path.join(root, 'created-before-drift.txt');
    const updatedPath = path.join(root, 'updated-before-drift.txt');
    await writeFile(createdPath, 'created\n', 'utf8');
    await writeFile(updatedPath, 'after\n', 'utf8');
    try {
      const store = new CheckpointStore(storage.checkpoints);
      store.record({
        path: createdPath,
        before: null,
        after: 'created\n',
        toolCallId: 'call-created',
        diff: 'create',
      });
      store.record({
        path: updatedPath,
        before: 'before\n',
        after: 'after\n',
        toolCallId: 'call-updated',
        diff: 'update',
      });
      const checkpoint = await store.seal('run-drift');
      await writeFile(updatedPath, 'manual user edit\n', 'utf8');

      await expect(store.rollback(checkpoint!.id)).rejects.toThrow(
        'file drifted',
      );
      await expect(readFile(createdPath, 'utf8')).resolves.toBe('created\n');
      await expect(readFile(updatedPath, 'utf8')).resolves.toBe(
        'manual user edit\n',
      );
      expect(
        storage.db.$client
          .prepare('select status from checkpoints where id = ?')
          .get(checkpoint!.id),
      ).toEqual({ status: 'active' });
      expect(
        storage.db.$client
          .prepare(
            'select status from checkpoint_rollbacks where checkpoint_id = ?',
          )
          .get(checkpoint!.id),
      ).toEqual({ status: 'failed' });
    } finally {
      storage.close();
    }
  });

  it('生产工具输出自动记录绝对路径，移动文件拆成可逆的删除与新增', async () => {
    const { root, storage } = await createTestStorage();
    const source = path.join(root, 'source.txt');
    const moved = path.join(root, 'nested', 'moved.txt');
    await mkdir(path.dirname(moved), { recursive: true });
    await writeFile(moved, 'after\n', 'utf8');
    try {
      const store = new CheckpointStore(storage.checkpoints);
      recordCheckpointChanges({
        checkpoints: store,
        cwd: root,
        toolCallId: 'call-move',
        output: {
          kind: 'coding-tool-result',
          title: 'Move file',
          output: 'moved',
          metadata: {
            kind: 'edit',
            fileChanges: [
              {
                kind: 'modified',
                path: 'source.txt',
                movePath: 'nested/moved.txt',
                before: 'before\n',
                after: 'after\n',
                additions: 1,
                deletions: 1,
                hunks: [],
                unifiedDiff: 'move diff',
              },
            ],
          },
        },
      });
      const checkpoint = await store.seal('run-move');

      expect(checkpoint?.changes).toEqual([
        expect.objectContaining({
          path: source,
          before: 'before\n',
          after: null,
        }),
        expect.objectContaining({
          path: moved,
          before: null,
          after: 'after\n',
        }),
      ]);
      await store.rollback(checkpoint!.id);
      await expect(readFile(source, 'utf8')).resolves.toBe('before\n');
      await expect(readFile(moved, 'utf8')).rejects.toThrow();
    } finally {
      storage.close();
    }
  });

  it('检查点持久化失败时保留待封存改动，允许显式重试', async () => {
    const { root, storage } = await createTestStorage();
    try {
      const store = new CheckpointStore(storage.checkpoints);
      store.record({
        path: path.join(root, 'retry.txt'),
        before: null,
        after: 'retry',
        toolCallId: 'call-retry',
        diff: 'retry diff',
      });
      const failure = vi
        .spyOn(storage.checkpoints, 'seal')
        .mockRejectedValueOnce(new Error('暂时写盘失败'));

      await expect(store.seal('run-retry')).rejects.toThrow('暂时写盘失败');
      expect(store.hasPending()).toBe(true);
      failure.mockRestore();
      await expect(store.seal('run-retry')).resolves.toMatchObject({
        runId: 'run-retry',
      });
      expect(store.hasPending()).toBe(false);
    } finally {
      storage.close();
    }
  });

  it('检查点写入中途失败会清理已创建 artifact 且不留下半条元数据', async () => {
    const { root, storage } = await createTestStorage();
    const realPut = storage.artifacts.put.bind(storage.artifacts);
    vi.spyOn(storage.artifacts, 'put')
      .mockImplementationOnce(realPut)
      .mockRejectedValueOnce(new Error('artifact 写入失败'));
    try {
      await expect(
        storage.checkpoints.seal({
          runId: 'run-failed',
          changes: [
            {
              path: path.join(root, 'file.txt'),
              before: 'before',
              after: 'after',
              toolCallId: 'call-1',
              diff: 'diff',
            },
          ],
        }),
      ).rejects.toThrow('artifact 写入失败');
      expect(
        storage.db.$client
          .prepare('select count(*) as count from checkpoints')
          .get(),
      ).toEqual({ count: 0 });
      expect(
        storage.db.$client
          .prepare('select count(*) as count from artifacts')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      storage.close();
    }
  });

  it('未知检查点查询和回滚返回明确失败', async () => {
    const { storage } = await createTestStorage();
    try {
      await expect(storage.checkpoints.detail('missing')).resolves.toBeNull();
      const store = new CheckpointStore(storage.checkpoints);
      await expect(store.rollback('missing')).rejects.toThrow(
        'Unknown checkpoint: missing',
      );
      await expect(store.rollback()).rejects.toThrow(
        'No checkpoint to roll back',
      );
    } finally {
      storage.close();
    }
  });
});

describe('Usage 仓储契约', () => {
  it('按模型、日期、状态和时间范围过滤及聚合安全字段', async () => {
    const { storage } = await createTestStorage();
    try {
      storage.usage.recordUsage({
        runId: 'run-1',
        invocation: 'run',
        provider: 'fake',
        model: 'fake:a',
        status: 'completed',
        startedAt: '2026-06-29T00:00:00.000Z',
        estimatedCostUsd: 0.25,
        usage: {
          requests: 1,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          toolCalls: 3,
        },
      });
      storage.usage.recordUsage({
        runId: 'run-2',
        invocation: 'tui',
        model: 'fake:b',
        status: 'failed',
        startedAt: '2026-06-30T00:00:00.000Z',
      });

      expect(storage.usage.listRecords({ model: 'fake:a' })).toHaveLength(1);
      expect(
        storage.usage.listRecords({
          since: '2026-06-30T00:00:00.000Z',
          until: '2026-06-30T23:59:59.999Z',
          status: 'failed',
        }),
      ).toHaveLength(1);
      expect(storage.usage.summarize({}, 'model')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'fake:a',
            inputTokens: 10,
            estimatedCostUsd: 0.25,
            runs: 1,
          }),
          expect.objectContaining({ key: 'fake:b', inputTokens: 0, runs: 1 }),
        ]),
      );
      expect(storage.usage.summarize({}, 'day')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: '2026-06-29', runs: 1 }),
          expect.objectContaining({ key: '2026-06-30', runs: 1 }),
        ]),
      );
      expect(storage.usage.summarize({}, 'status')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'completed', runs: 1 }),
          expect.objectContaining({ key: 'failed', runs: 1 }),
        ]),
      );
    } finally {
      storage.close();
    }
  });

  it('按 model-call 聚合 run summary 并分离 cache 命中诊断', async () => {
    const { storage } = await createTestStorage();
    try {
      for (const turnIndex of [0, 1]) {
        storage.usage.recordModelCall(
          completedModelCall({
            turnIndex,
            cacheReadTokens: turnIndex === 0 ? 0 : 80,
            cacheWriteTokens: turnIndex === 0 ? 50 : 0,
          }),
        );
      }

      const summary = storage.usage.recordRunSummary({
        runId: 'run-model-calls',
        invocation: 'run',
        model: 'openai/gpt-5.4',
        status: 'completed',
        finishReason: 'stop',
        toolCalls: 1,
      });

      expect(storage.usage.listModelCalls('run-model-calls')).toHaveLength(2);
      expect(summary).toMatchObject({
        requests: 2,
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 80,
        cacheWriteTokens: 50,
        toolCalls: 1,
      });
      expect(storage.usage.summarize({}, 'model')).toContainEqual(
        expect.objectContaining({
          key: 'openai/gpt-5.4',
          cacheReadRatio: 0.4,
          cacheWriteRatio: 0.25,
          uncachedInputTokens: 120,
        }),
      );
    } finally {
      storage.close();
    }
  });

  it('完成记录必须提供 usage，失败记录可使用明确的零值', async () => {
    const { storage } = await createTestStorage();
    try {
      expect(() =>
        storage.usage.recordUsage({
          runId: 'missing-usage',
          invocation: 'run',
          model: 'fake:model',
          status: 'completed',
        }),
      ).toThrow('is missing usage');
      expect(
        storage.usage.recordUsage({
          runId: 'failed-run',
          invocation: 'run',
          model: 'fake:model',
          status: 'failed',
        }),
      ).toMatchObject({
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolCalls: 0,
      });
    } finally {
      storage.close();
    }
  });

  it('拒绝负 token、缓存读取超过输入和负成本', async () => {
    const { storage } = await createTestStorage();
    try {
      const invalidRecords = [
        {
          inputTokens: -1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          toolCalls: 0,
        },
        {
          inputTokens: 1,
          outputTokens: 0,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
          toolCalls: 0,
        },
      ];
      for (const [index, usage] of invalidRecords.entries()) {
        expect(() =>
          storage.usage.recordUsage({
            runId: `invalid-${index}`,
            invocation: 'run',
            model: 'fake:model',
            status: 'completed',
            usage: { requests: 1, ...usage },
          }),
        ).toThrow();
      }
      expect(() =>
        storage.usage.recordUsage({
          runId: 'negative-cost',
          invocation: 'run',
          model: 'fake:model',
          status: 'completed',
          estimatedCostUsd: -1,
          usage: {
            requests: 1,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            toolCalls: 0,
          },
        }),
      ).toThrow();
    } finally {
      storage.close();
    }
  });

  it('拒绝负模型调用时长和同一 run 的重复 turn', async () => {
    const { storage } = await createTestStorage();
    try {
      expect(() =>
        storage.usage.recordModelCall({
          ...completedModelCall({ turnIndex: 0 }),
          occurredAt: '2026-06-29T00:00:00.000Z',
          startedAt: '2026-06-29T00:00:01.000Z',
        }),
      ).toThrow('durationMs must be a non-negative number');

      storage.usage.recordModelCall(completedModelCall({ turnIndex: 0 }));
      expect(() =>
        storage.usage.recordModelCall(completedModelCall({ turnIndex: 0 })),
      ).toThrow();
      expect(storage.usage.listModelCalls('run-model-calls')).toHaveLength(1);
    } finally {
      storage.close();
    }
  });

  it('持久化表不包含 prompt、completion、工具参数或凭据字段', async () => {
    const { storage } = await createTestStorage();
    try {
      const columns = storage.db.$client
        .prepare('pragma table_info(usage_records)')
        .all()
        .map((row) => (row as { readonly name: string }).name);
      expect(columns).not.toEqual(
        expect.arrayContaining([
          'prompt',
          'completion',
          'tool_input',
          'tool_output',
          'api_key',
          'credential',
        ]),
      );
    } finally {
      storage.close();
    }
  });
});

function completedModelCall(input: {
  readonly turnIndex: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}) {
  const startedSecond = input.turnIndex * 2;
  const completedSecond = startedSecond + 1;
  return {
    type: 'model.completed' as const,
    runId: 'run-model-calls',
    sequence: input.turnIndex + 1,
    occurredAt: `2026-06-29T00:00:0${completedSecond}.000Z`,
    identity: {
      runId: 'run-model-calls',
      turnIndex: input.turnIndex,
      modelCallId: `call-${input.turnIndex}`,
      provider: 'openai',
      model: 'gpt-5.4',
    },
    response: {
      text: '',
      messages: [],
      usage: {
        requests: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: input.cacheReadTokens ?? 0,
        cacheWriteTokens: input.cacheWriteTokens ?? 0,
        toolCalls: input.turnIndex === 0 ? 1 : 0,
      },
      finishReason:
        input.turnIndex === 0 ? ('tool-calls' as const) : ('stop' as const),
      provider: null,
    },
    diagnostics: {
      systemFingerprint: 'system',
      toolsetFingerprint: 'tools',
      messagePrefixFingerprint: `messages-${input.turnIndex}`,
      compactionBoundary: false,
    },
    startedAt: `2026-06-29T00:00:0${startedSecond}.000Z`,
  };
}
