import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config/index.js';
import { createCodingMemory } from '../context/memory.js';
import { loadCodingMemory, renderMemoryForPrompt } from '../memory.js';

describe('file memory', () => {
  let previousHome: string | undefined;
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    previousHome = process.env.ELLO_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'ello-memory-home-'));
    cwd = await mkdtemp(path.join(tmpdir(), 'ello-memory-cwd-'));
    process.env.ELLO_HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.ELLO_HOME;
    } else {
      process.env.ELLO_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('加载项目 Markdown memory', async () => {
    await mkdir(path.join(cwd, '.ello'), { recursive: true });
    await writeFile(path.join(cwd, '.ello', 'memory.md'), '项目记忆\n', 'utf8');

    const manifest = await loadCodingMemory(cwd);
    expect(manifest.files).toHaveLength(1);
    expect(renderMemoryForPrompt(manifest, cwd)).toContain('项目记忆');
  });

  it('context memory 默认关闭', async () => {
    const config = await loadCodingAgentConfig({ cwd });
    const section = createCodingMemory(config);

    expect(section({ runId: 'run-memory-off' } as never)).toBeNull();
  });
});
