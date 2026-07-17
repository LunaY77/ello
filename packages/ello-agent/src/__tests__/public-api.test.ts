import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import * as agent from '../index.js';

describe('@ello/agent public API', () => {
  it('只暴露稳定运行时入口', () => {
    expect(Object.keys(agent).sort()).toEqual([
      'AgentStreamBackpressureError',
      'AiSdkModelAdapter',
      'ModelAdapterProtocolError',
      'activeSkillsContext',
      'createAgent',
      'createAiSdkLanguageModel',
      'createLocalEnvironment',
      'createLocalShellEnvironment',
      'createSkillTools',
      'defineDeferredTool',
      'defineTool',
      'skillIndexContext',
      'z',
    ]);
  });

  it('package exports 不包含 internal 子路径', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { readonly exports: Record<string, unknown> };
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      '.',
      './environment',
    ]);
  });
});
