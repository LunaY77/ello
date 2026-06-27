import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCodingMemory, renderMemoryForPrompt } from '../memory.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('memory', () => {
  it('loads project memory files into prompt text', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ello-memory-'));
    dirs.push(dir);
    await mkdir(path.join(dir, '.ello'));
    await writeFile(path.join(dir, 'AGENTS.md'), 'Use repo conventions.');
    await writeFile(path.join(dir, '.ello', 'memory.md'), 'Remember session facts.');

    const manifest = await loadCodingMemory(dir);
    const prompt = renderMemoryForPrompt(manifest, dir);

    expect(manifest.files.map((file) => path.relative(dir, file.path))).toEqual([
      'AGENTS.md',
      path.join('.ello', 'memory.md'),
    ]);
    expect(prompt).toContain('Use repo conventions.');
    expect(prompt).toContain('Remember session facts.');
  });
});
