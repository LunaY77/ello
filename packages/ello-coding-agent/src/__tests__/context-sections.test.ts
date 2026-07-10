import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadCodingAgentConfig,
  type CodingAgentConfig,
} from '../config/index.js';
import { splitSystemCacheSegments } from '../context/cache-layout.js';
import { ContextSnapshot } from '../context/context-snapshot.js';
import {
  buildCodingSystemPrompt,
  buildContextBundle,
  createCodingSystemPromptSection,
} from '../context/prompts.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ello-context-'));
  dirs.push(dir);
  return dir;
}

describe('context sections', () => {
  it('keeps base prompt in markdown template and runtime context in sources', async () => {
    const cwd = await tempDir();
    const config = await loadCodingAgentConfig({ cwd });

    const prompt = buildCodingSystemPrompt(config, { model: 'test/model' });
    const text = (await buildContextBundle(config)).system;

    expect(prompt).toContain('You are ello');
    expect(prompt).not.toContain('<environment-context>');
    expect(text).toContain('<environment-context');
    expect(prompt).not.toContain('- Working directory:');
    expect(prompt).not.toContain('- Writable roots:');
  });

  it('does not inject repository or git context by default', async () => {
    const cwd = await tempDir();
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        scripts: { test: 'vitest' },
      }),
      'utf8',
    );
    const config = await loadCodingAgentConfig({ cwd });

    const text = (await buildContextBundle(config)).system;
    expect(text).not.toContain('<repository-context');
    expect(text).not.toContain('<git-context');
    expect(text).not.toContain('package: demo@1.0.0');
  });

  it('loads extra instruction globs as context sources', async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, 'docs'), { recursive: true });
    await writeFile(
      path.join(cwd, 'docs', 'rules.agent.md'),
      'Use local rules.',
      'utf8',
    );
    const base = await loadCodingAgentConfig({ cwd });
    const config: CodingAgentConfig = {
      ...base,
      context: {
        ...base.context,
        instructions: {
          ...base.context.instructions,
          extra: ['docs/**/*.agent.md'],
        },
      },
    };

    const text = (await buildContextBundle(config)).system;

    expect(text).toContain('<instruction-context');
    expect(text).toContain('Use local rules.');
  });

  it('同一 run snapshot 不重复读取 instruction，新 run 才读取新内容', async () => {
    const cwd = await tempDir();
    const instruction = path.join(cwd, 'AGENTS.md');
    await writeFile(instruction, 'first rule', 'utf8');
    const config = await loadCodingAgentConfig({ cwd });
    const snapshot = new ContextSnapshot(config, {}, 'coding', 'base-hash');

    const first = await snapshot.render();
    await writeFile(instruction, 'second rule', 'utf8');
    const sameRun = await snapshot.render();
    const nextRun = await new ContextSnapshot(
      config,
      {},
      'coding',
      'base-hash',
    ).render();

    expect(first.system).toContain('first rule');
    expect(sameRun.system).toContain('first rule');
    expect(sameRun.system).not.toContain('second rule');
    expect(nextRun.system).toContain('second rule');
  });

  it('同一 snapshot 只更新 active skill section', async () => {
    const cwd = await tempDir();
    const config = await loadCodingAgentConfig({ cwd });
    let activeSkills = ['review'];
    const snapshot = new ContextSnapshot(
      config,
      { activeSkills: () => activeSkills },
      'coding',
      'base-hash',
    );
    const first = await snapshot.render();
    activeSkills = ['verify'];
    const second = await snapshot.render();

    expect(first.system).toContain('- review');
    expect(second.system).toContain('- verify');
    expect(second.system).not.toContain('- review');
    expect(second.stableSystem).toBe(first.stableSystem);
    expect(first.dynamicSystem).toContain('- review');
    expect(second.dynamicSystem).toContain('- verify');
  });

  it('动态 skill 变化不会改写稳定 prompt 与 instruction 前缀', async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, 'AGENTS.md'), 'stable project rule', 'utf8');
    const config = await loadCodingAgentConfig({ cwd });
    let activeSkills = ['review'];
    const section = createCodingSystemPromptSection(config, {
      model: 'openai/gpt-5.4',
      activeSkills: () => activeSkills,
    });
    const run = {} as never;

    const first = splitSystemCacheSegments((await section(run))!);
    activeSkills = ['verify'];
    const second = splitSystemCacheSegments((await section(run))!);

    expect(first.stable).toBe(second.stable);
    expect(first.stable).toContain('stable project rule');
    expect(first.dynamic).toContain('- review');
    expect(second.dynamic).toContain('- verify');
  });

  it('URL TTL cache hit 保持 fresh 且 fingerprint 不变', async () => {
    const cwd = await tempDir();
    const url = 'https://instructions.example/fresh';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => 'remote rule',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const base = await loadCodingAgentConfig({ cwd });
    const config: CodingAgentConfig = {
      ...base,
      context: {
        ...base.context,
        instructions: {
          ...base.context.instructions,
          extra: [url],
        },
      },
    };

    const first = await new ContextSnapshot(
      config,
      {},
      'coding',
      'base-hash',
    ).render();
    const cached = await new ContextSnapshot(
      config,
      {},
      'coding',
      'base-hash',
    ).render();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      cached.sources.find((source) => source.origin === url)?.stale,
    ).not.toBe(true);
    expect(cached.fingerprint).toBe(first.fingerprint);
  });

  it('URL 刷新失败时使用过期缓存并标记 stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const cwd = await tempDir();
    const url = 'https://instructions.example/stale';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => 'remote rule' })
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const base = await loadCodingAgentConfig({ cwd });
    const config: CodingAgentConfig = {
      ...base,
      context: {
        ...base.context,
        instructions: {
          ...base.context.instructions,
          extra: [url],
        },
      },
    };
    await new ContextSnapshot(config, {}, 'coding', 'base-hash').render();
    vi.setSystemTime(new Date('2026-01-01T00:06:00.000Z'));

    const stale = await new ContextSnapshot(
      config,
      {},
      'coding',
      'base-hash',
    ).render();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stale.sources.find((source) => source.origin === url)?.stale).toBe(
      true,
    );
    expect(stale.diagnostics).toContainEqual(
      expect.objectContaining({
        origin: url,
        message: expect.stringContaining('network down'),
      }),
    );
  });
});
