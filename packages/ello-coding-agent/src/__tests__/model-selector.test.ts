import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config/index.js';
import {
  buildModelCatalogOptions,
  buildProfileSelectorOptions,
} from '../tui/model-selectors.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('model selector', () => {
  it('按 profile suite 分组展示可切换 profile', async () => {
    const cwd = await tempDir();
    const config = await loadCodingAgentConfig({ cwd });

    const options = buildProfileSelectorOptions(config);
    const labels = options.map((option) => option.label);
    const values = options
      .filter((option) => option.disabled !== true)
      .map((option) => option.value);

    expect(labels).toContain('Profiles');
    expect(labels.some((label) => label.includes('main [active]'))).toBe(true);
    expect(labels.some((label) => label.includes('anthropic'))).toBe(true);
    expect(labels.some((label) => label.includes('高质量编码任务'))).toBe(true);
    expect(labels.some((label) => label.includes('openai/'))).toBe(false);
    expect(labels.some((label) => label.includes('anthropic/'))).toBe(false);
    expect(values).toEqual(['anthropic', 'main']);
  });

  it('按 provider 分组展示模型目录', async () => {
    const cwd = await tempDir();
    const config = await loadCodingAgentConfig({ cwd });

    const options = buildModelCatalogOptions(config);
    const labels = options.map((option) => option.label);
    const values = options
      .filter((option) => option.disabled !== true)
      .map((option) => option.value);

    expect(labels).toContain('OpenAI');
    expect(labels).toContain('Anthropic');
    expect(labels).not.toContain('OpenAI Compatible');
    expect(values).toContain('openai/gpt-5.5');
    expect(values).toContain('openai/gpt-5.4');
    expect(values).toContain('anthropic/claude-opus-4.8');
    expect(values).not.toContain('openai-compatible/deepseek-v4-flash');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ello-model-selector-'));
  dirs.push(dir);
  return dir;
}
