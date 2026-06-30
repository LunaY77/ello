import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config/index.js';
import { buildSystemSections } from '../context/sections.js';
import { buildCodingSystemPrompt } from '../system-prompt.js';

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
  it('keeps runtime environment compact and structured', async () => {
    const cwd = await tempDir();
    const config = await loadCodingAgentConfig({ cwd });

    const prompt = buildCodingSystemPrompt(config, { model: 'test/model' });

    expect(prompt).toContain('<environment-context>');
    expect(prompt).toContain('<model>test/model</model>');
    expect(prompt).not.toContain('- Working directory:');
    expect(prompt).not.toContain('- Writable roots:');
  });

  it('renders repository context as a compact source block', async () => {
    const cwd = await tempDir();
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'vitest' } }),
      'utf8',
    );
    const config = await loadCodingAgentConfig({ cwd });
    const sections = buildSystemSections(config);
    const rendered = await Promise.all(
      sections.map((section) =>
        section({
          runId: 'run',
          agentName: 'ello',
          input: '',
          context: undefined,
          options: {},
          environment: {},
          metadata: {},
          state: { messages: [], budget: {}, turn: 0, queueDiagnostics: [] },
          trace: { events: [], metadata: {} },
        }),
      ),
    );

    const text = rendered.filter(Boolean).join('\n\n');
    expect(text).toContain('<repository-context>');
    expect(text).toContain('package: demo@1.0.0');
    expect(text).not.toContain('# Repository overview');
  });
});
