/**
 * 本文件验证 storage-domain-contract 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestStores, type TestStores } from '../support/stores.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTestStorage(): Promise<{
  readonly root: string;
  readonly storage: TestStores;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-storage-contract-'));
  temporaryDirectories.push(root);
  return {
    root,
    storage: createTestStores({
      databasePath: path.join(root, 'state.sqlite'),
      artifactsDir: path.join(root, 'artifacts'),
    }),
  };
}

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
      agentName: 'build',
      modelSelector: 'primary_model' as const,
      configuredModel: 'openai-gpt-5.4',
      protocol: 'openai' as const,
      apiModel: 'gpt-5.4',
    },
    response: {
      text: '',
      messages: [],
      newMessages: [],
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
