import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextSnapshot } from '../../src/agent/context/context-snapshot.js';
import { loadInstructionSources } from '../../src/agent/context/instructions.js';
import {
  loadContextBundle,
  type ContextEvent,
} from '../../src/agent/context/source-registry.js';
import { compactMessages } from '../../src/agent/engine/core/input-transforms.js';
import {
  CodingAgentConfigSchema,
  type CodingAgentConfig,
} from '../../src/config/schema.js';
import type { ServerConnection } from '../../src/server/connection/server-connection.js';
import { ServerServices } from '../../src/server/methods/server-services.js';

describe('context source contract', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it('按 priority 和 id 稳定排序，并保留 stale 诊断', async () => {
    const events: ContextEvent[] = [];
    const bundle = await loadContextBundle(
      [
        async () => ({
          sources: [source('shared', 30, 'low priority copy')],
        }),
        async () => ({
          sources: [
            source('z-last', 20, 'z'),
            source('shared', 10, 'high priority copy', true),
            source('a-first', 20, 'a'),
          ],
          diagnostics: [
            {
              level: 'warn' as const,
              origin: 'https://example.test/rules',
              message: 'refresh failed; cached value used',
            },
          ],
        }),
      ],
      (event) => events.push(event),
    );

    expect(bundle.sources.map(({ id }) => id)).toEqual([
      'shared',
      'a-first',
      'z-last',
    ]);
    expect(bundle.sources[0]).toMatchObject({
      content: 'high priority copy',
      stale: true,
    });
    expect(bundle.system).toContain('stale="true"');
    expect(events.map(({ type }) => type)).toEqual([
      'context.source.loaded',
      'context.source.loaded',
      'context.source.loaded',
      'context.source.failed',
    ]);
  });

  it('同一 run 冻结文件快照，新 run 才读取文件变化', async () => {
    const root = await temporaryRoot();
    const instructionPath = path.join(root, 'AGENTS.md');
    await writeFile(instructionPath, 'first contract\n', 'utf8');
    const config = configFor(root, ['AGENTS.md']);
    const firstRun = new ContextSnapshot(config, {}, 'coding', 'base-hash');

    const beforeChange = await firstRun.render();
    await writeFile(instructionPath, 'second contract\n', 'utf8');
    const sameRun = await firstRun.render();
    const nextRun = await new ContextSnapshot(
      config,
      {},
      'coding',
      'base-hash',
    ).render();

    expect(sameRun.system).toBe(beforeChange.system);
    expect(sameRun.fingerprint).toBe(beforeChange.fingerprint);
    expect(sameRun.system).toContain('first contract');
    expect(nextRun.system).toContain('second contract');
    expect(nextRun.fingerprint).not.toBe(beforeChange.fingerprint);
  });

  it('glob 结果稳定排序，并按真实文件来源去重', async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, 'rules'));
    await writeFile(path.join(root, 'rules', 'b.md'), 'rule b', 'utf8');
    await writeFile(path.join(root, 'rules', 'a.md'), 'rule a', 'utf8');

    const loaded = await loadInstructionSources(
      configFor(root, ['rules/*.md', 'rules/a.md']),
    );

    expect(
      loaded.sources.map(({ origin }) => path.basename(origin ?? '')),
    ).toEqual(['a.md', 'b.md']);
    expect(loaded.sources.map(({ content }) => content)).toEqual([
      'rule a',
      'rule b',
    ]);
  });

  it('URL 刷新失败使用显式 stale 缓存，无缓存时明确失败', async () => {
    const root = await temporaryRoot();
    const url = `https://context.test/${path.basename(root)}`;
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'remote contract',
    });
    vi.stubGlobal('fetch', fetchMock);
    const config = configFor(root, [url]);

    const fresh = await loadInstructionSources(config);
    vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60 * 1000 + 1);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '',
    });
    const stale = await loadInstructionSources(config);

    expect(fresh.sources[0]).toMatchObject({ content: 'remote contract' });
    expect(fresh.sources[0]).not.toHaveProperty('stale');
    expect(stale.sources[0]).toMatchObject({
      content: 'remote contract',
      stale: true,
    });
    expect(stale.diagnostics).toEqual([
      expect.objectContaining({ level: 'warn', origin: url }),
    ]);

    await expect(
      loadInstructionSources(
        configFor(root, [
          `https://context.test/missing-${path.basename(root)}`,
        ]),
      ),
    ).rejects.toThrow('HTTP 503');
  });

  it('手动压缩没有生产 runner 时明确失败，不写入虚假 compaction 事件', async () => {
    const services = new ServerServices({
      threads: {} as never,
      logs: {} as never,
      storage: {
        artifacts: {
          deleteExpiredReferences: () =>
            Promise.resolve({ deleted: 0, bytesFreed: 0 }),
        },
      } as never,
    });
    await expect(
      services.dispatch({} as ServerConnection, 'thread/compact/start', {
        threadId: 'thr_context_contract',
      }),
    ).rejects.toMatchObject({
      type: 'invalidParams',
      message: expect.stringContaining('no production compaction runner'),
    });
  });

  it('按输入预算保留最新消息，并拒绝无可用输入空间的参数', async () => {
    const transform = compactMessages({
      maxInputTokens: 10,
      reservedOutputTokens: 2,
    });
    const messages = [
      { role: 'user' as const, content: '1111111111111111' },
      { role: 'assistant' as const, content: '2222222222222222' },
      { role: 'user' as const, content: '3333333333333333' },
    ];

    await expect(transform(messages, {} as never)).resolves.toEqual(
      messages.slice(1),
    );
    expect(() => compactMessages({ maxInputTokens: 0 })).toThrow(
      'maxInputTokens must be a positive safe integer',
    );
    expect(() =>
      compactMessages({ maxInputTokens: 8, reservedOutputTokens: 8 }),
    ).toThrow('reservedOutputTokens must be');
    expect(() =>
      CodingAgentConfigSchema.parse({
        cwd: '/workspace',
        initial_mode: 'ask-before-changes',
        context: { max_input_tokens: 8, reserved_output_tokens: 8 },
      }),
    ).toThrow('must be below max_input_tokens');
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-context-contract-'));
    roots.push(root);
    return root;
  }
});

function configFor(
  cwd: string,
  projectInstructions: readonly string[],
): CodingAgentConfig {
  return CodingAgentConfigSchema.parse({
    cwd,
    initial_mode: 'ask-before-changes',
    context: {
      instructions: {
        global: [],
        project: projectInstructions,
        extra: [],
        nearby: false,
      },
    },
  });
}

function source(id: string, priority: number, content: string, stale = false) {
  return {
    id,
    type: 'instruction' as const,
    title: id,
    priority,
    content,
    ...(stale ? { stale: true } : {}),
  };
}
