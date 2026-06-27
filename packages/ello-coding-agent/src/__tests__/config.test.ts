import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config.js';
import { getProjectConfigPath, setProjectConfigValue } from '../config.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('loadCodingAgentConfig', () => {
  it('loads project config and lets overrides win', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ello-config-'));
    dirs.push(dir);
    await mkdir(path.join(dir, '.ello'));
    await writeFile(
      path.join(dir, '.ello', 'config.json'),
      JSON.stringify({
        model: 'openai-chat:gpt-4.1-mini',
        modelCandidates: ['openai-chat:gpt-4.1-mini', 'anthropic:claude-test'],
        allowedPaths: ['src'],
      }),
    );

    const config = await loadCodingAgentConfig({
      cwd: dir,
      model: 'anthropic:claude-sonnet-4-5',
    });

    expect(config.model).toBe('anthropic:claude-sonnet-4-5');
    expect(config.modelCandidates).toEqual([
      'openai-chat:gpt-4.1-mini',
      'anthropic:claude-test',
    ]);
    expect(config.allowedPaths).toEqual([path.join(dir, 'src')]);
  });

  it('writes project config values', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ello-config-'));
    dirs.push(dir);

    const config = await setProjectConfigValue(dir, 'model', 'openai-chat:test');

    expect(getProjectConfigPath(dir)).toBe(path.join(dir, '.ello', 'config.json'));
    expect(config.model).toBe('openai-chat:test');
  });
});
