import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import * as agent from '../index.js';

describe('@ello/agent public API', () => {
  it('只暴露 App Server 生命周期', () => {
    expect(Object.keys(agent).sort()).toEqual([
      'AgentServer',
      'bootstrapAgentServer',
    ]);
  });

  it('package exports 不包含 internal 子路径', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { readonly exports: Record<string, unknown> };
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      '.',
      './package.json',
      './protocol',
      './server-entry',
    ]);
  });
});
