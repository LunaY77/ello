/**
 * 本文件验证 context-contract 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextSnapshot } from '../../src/features/agent/context/context-snapshot.js';
import { loadInstructionSources } from '../../src/features/agent/context/instructions.js';
import { createCodingSystemPromptSection } from '../../src/features/agent/context/prompts.js';
import {
  loadContextBundle,
  type ContextEvent,
} from '../../src/features/agent/context/source-registry.js';
import type { AgentRunContext } from '../../src/features/agent/engine/contracts.js';
import { preserveToolCallPairs } from '../../src/features/agent/engine/model-input.js';
import {
  CodingAgentConfigSchema,
  type CodingAgentConfig,
} from '../../src/features/config/schema.js';
import { createThreadRoutes } from '../../src/features/thread/routes.js';
import { createTestEnvironmentHandle } from '../support/environment.js';
import { createTestPeer, invokeServiceRoute } from '../support/rpc.js';

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

  it('Command Run 说明固定唯一 Tool 与 step 调度语义', async () => {
    const root = await temporaryRoot();
    const section = createCodingSystemPromptSection(configFor(root, []), {
      model: 'test-model',
    });
    const prompt = await section(promptRunContext());

    expect(prompt).toContain('`command_run` is the only model-visible Tool');
    expect(prompt).toContain(
      'Commands in the same `step` must be independent; dependent Commands use a later `step`',
    );
    expect(prompt).toContain(
      'Include all currently known actions whose inputs are available',
    );
    expect(prompt).toContain(
      'Prefer the registered `search` Command for repository search',
    );
    expect(prompt).toContain(
      'Treat the current Command Catalog as authoritative. Do not invent Commands, fields, arguments, or calling conventions',
    );
    expect(prompt).not.toContain(
      'Use `read`, `search`, `write`, `apply_patch`, and `bash` for direct environment operations',
    );
    expect(prompt).not.toContain(
      'Before overwriting an existing file with `write`',
    );
    expect(prompt).not.toContain('multi_tool_use.parallel');
  });

  it('关闭 subagent 时同时移除委派规则和 runtime delegation context', async () => {
    const root = await temporaryRoot();
    const config = CodingAgentConfigSchema.parse({
      cwd: root,
      initial_mode: 'ask-before-changes',
      ...modelConfig(),
      subagents: { enabled: false },
      context: {
        instructions: {
          global: [],
          project: [],
          extra: [],
          nearby: false,
        },
      },
    });
    const section = createCodingSystemPromptSection(config, {
      model: 'test-model',
    });

    const prompt = await section(promptRunContext());

    expect(prompt).not.toContain('# Delegation');
    expect(prompt).not.toContain('<delegation>');
  });

  it('把 coding scope 标为 Tool Policy 而不是 Environment 隔离能力', async () => {
    const root = await temporaryRoot();
    const sibling = path.join(path.dirname(root), 'authorized-sibling');
    const config = CodingAgentConfigSchema.parse({
      cwd: root,
      allowed_paths: [sibling],
      initial_mode: 'ask-before-changes',
      ...modelConfig(),
    });

    const rendered = await new ContextSnapshot(
      config,
      {},
      'coding',
      'base-hash',
    ).render();

    expect(rendered.system).toContain(
      '<policy-context id="policy:runtime" title="Runtime tool policy"',
    );
    expect(rendered.system).toContain('<coding-scope>');
    expect(rendered.system).toContain('<authorized-paths>');
    expect(rendered.system).toContain(root);
    expect(rendered.system).toContain(sibling);
    expect(rendered.system).toContain(
      'it is not an Environment isolation claim',
    );
    expect(rendered.system).not.toContain('<file-system>');
    expect(rendered.system).not.toContain('<shell>');
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

  it('手动压缩返回完整持久化报告', async () => {
    const compactThread = vi.fn(async () => ({
      id: 'compaction-12',
      threadId: 'thr_context_contract',
      turnId: 'turn_context_contract',
      createdAt: '2026-07-28T00:00:00.000Z',
      compactor: 'ello-thread-compactor',
      beforeMessageCount: 12,
      afterMessageCount: 3,
      keptMessageCount: 2,
      tokensBefore: 4_000,
      summary: 'compact checkpoint',
    }));
    const services = {
      routes: createThreadRoutes({
        artifacts: {} as never,
        compact: compactThread,
        interruptCompact: () => undefined,
        threads: {} as never,
      }),
    };

    await expect(
      invokeServiceRoute(services, createTestPeer(), 'thread/compact/start', {
        threadId: 'thr_context_contract',
      }),
    ).resolves.toMatchObject({
      id: 'compaction-12',
      summary: 'compact checkpoint',
      beforeMessageCount: 12,
      afterMessageCount: 3,
    });
    expect(compactThread).toHaveBeenCalledWith('thr_context_contract');
  });

  it('手动压缩中断路由转发目标 Thread', async () => {
    const interruptCompact = vi.fn();
    const services = {
      routes: createThreadRoutes({
        artifacts: {} as never,
        compact: vi.fn(async () => null),
        interruptCompact,
        threads: {} as never,
      }),
    };

    await expect(
      invokeServiceRoute(
        services,
        createTestPeer(),
        'thread/compact/interrupt',
        { threadId: 'thr_context_contract' },
      ),
    ).resolves.toEqual({ ok: true });
    expect(interruptCompact).toHaveBeenCalledWith('thr_context_contract');
  });

  it('上下文裁剪只保留完整的 outer command_run call/result 配对', () => {
    const call = {
      role: 'assistant' as const,
      content: [
        {
          type: 'tool-call' as const,
          toolCallId: 'outer-command-run',
          toolName: 'command_run',
          input: { commands: [{ step: 1, command: 'read' }] },
        },
      ],
    };
    const result = {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: 'outer-command-run',
          toolName: 'command_run',
          output: {
            type: 'json' as const,
            value: { status: 'completed', commands: [] },
          },
        },
      ],
    };

    expect(preserveToolCallPairs([call, result])).toEqual([call, result]);
    expect(preserveToolCallPairs([call])).toEqual([]);
    expect(preserveToolCallPairs([result])).toEqual([]);
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
    ...modelConfig(),
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

function modelConfig() {
  return {
    models: {
      test: {
        protocol: 'openai' as const,
        endpoint: 'responses' as const,
        api_model: 'test-model',
        base_url: 'https://api.example.test/v1',
        api_key_env: 'TEST_API_KEY',
        context_window: 128_000,
        max_output_tokens: 16_000,
        reasoning_effort: 'medium' as const,
      },
    },
    primary_model: 'test',
    auxiliary_model: 'test',
  };
}

function promptRunContext(): AgentRunContext {
  return {
    runId: 'run-tool-list-contract',
    agentName: 'build',
    input: '你有哪些工具？',
    context: undefined,
    options: {},
    environment: createTestEnvironmentHandle(),
    metadata: {},
  };
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
