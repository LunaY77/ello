import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadCodingAgentConfig,
  type CodingAgentConfig,
} from '../config/index.js';
import {
  buildCodingSystemPrompt,
  buildContextBundle,
} from '../context/prompts.js';

const dirs: string[] = [];

afterEach(async () => {
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
});
