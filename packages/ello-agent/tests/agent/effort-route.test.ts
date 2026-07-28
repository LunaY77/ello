/**
 * 验证 thinking effort RPC 按当前 agent 的模型选择器持久化全局配置。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentRoutes } from '../../src/features/agent/index.js';
import {
  ensureGlobalConfig,
  globalConfigPath,
  loadCodingAgentConfig,
} from '../../src/features/config/index.js';
import type { RpcPeer } from '../../src/server/rpc/route.js';

describe('agent effort route', () => {
  let previousHome: string | undefined;
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    previousHome = process.env.ELLO_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'ello-effort-home-'));
    cwd = await mkdtemp(path.join(tmpdir(), 'ello-effort-cwd-'));
    process.env.ELLO_HOME = home;
    await ensureGlobalConfig();
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.ELLO_HOME;
    else process.env.ELLO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('updates the named model selected by the current agent', async () => {
    const route = createAgentRoutes()['agent/effort/update'];
    await expect(
      route.run({} as RpcPeer, { cwd, agent: 'build', effort: 'max' }),
    ).resolves.toEqual({
      agent: 'build',
      selector: 'primary_model',
      model: 'openai-gpt-5.5',
      effort: 'max',
    });

    await expect(loadCodingAgentConfig({ cwd })).resolves.toMatchObject({
      models: { 'openai-gpt-5.5': { reasoning_effort: 'max' } },
    });
    await expect(readFile(globalConfigPath(), 'utf8')).resolves.toContain(
      'reasoning_effort: max',
    );
  });
});
