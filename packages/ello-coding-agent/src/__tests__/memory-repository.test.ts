import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config/index.js';
import { createCodingMemory } from '../context/memory.js';
import { loadCodingMemory, renderMemoryForPrompt } from '../memory.js';
import { MemoryRepository } from '../storage/repositories/memory-repository.js';

describe('MemoryRepository', () => {
  let oldHome: string | undefined;
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    oldHome = process.env.ELLO_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'ello-memory-home-'));
    cwd = await mkdtemp(path.join(tmpdir(), 'ello-memory-cwd-'));
    process.env.ELLO_HOME = home;
  });

  afterEach(async () => {
    if (oldHome === undefined) {
      delete process.env.ELLO_HOME;
    } else {
      process.env.ELLO_HOME = oldHome;
    }
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('合并项目 Markdown memory 和全局 DB memory，但不索引项目文件', async () => {
    await mkdir(path.join(cwd, '.ello'), { recursive: true });
    await writeFile(path.join(cwd, '.ello', 'memory.md'), '项目记忆\n', 'utf8');

    const repo = new MemoryRepository();
    const item = await repo.createManual({
      kind: 'preference',
      content: '全局偏好',
      tags: ['ui'],
    });
    await repo.markUsed(item.id, { runId: 'run-1', usedFor: 'prompt' });
    repo.close();

    const manifest = await loadCodingMemory(cwd);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.items).toHaveLength(1);
    expect(renderMemoryForPrompt(manifest, cwd)).toContain('项目记忆');
    expect(renderMemoryForPrompt(manifest, cwd)).toContain('全局偏好');
  });

  it('context memory 默认关闭，不读取或注入 memory section', async () => {
    await mkdir(path.join(cwd, '.ello'), { recursive: true });
    await writeFile(path.join(cwd, '.ello', 'memory.md'), '项目记忆\n', 'utf8');
    const config = await loadCodingAgentConfig({ cwd });
    const memory = createCodingMemory(config);

    const section = await memory.section({
      runId: 'run-memory-off',
    } as never);
    expect(section).toBeNull();
  });
});
