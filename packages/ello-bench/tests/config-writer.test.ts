import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ElloAgentSpecSchema } from '../src/domain/contract/index.js';
import { writeBenchmarkAgentConfig } from '../src/infra/config-writer.js';

describe('benchmark Agent config', () => {
  it('writes an isolated credential-free named model directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-config-'));
    const workspace = path.join(root, 'workspace');
    const elloHome = path.join(root, 'ello-home');
    await mkdir(workspace, { recursive: true });
    const agent = agentFixture();

    const files = await writeBenchmarkAgentConfig({
      elloHome,
      workspace,
      agent,
      snapshotPath: path.join(root, 'snapshot.json'),
    });
    const config = parse(await readFile(files.configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(config.primary_model).toBe('benchmark-pro');
    expect(config.auxiliary_model).toBe('benchmark-flash');
    expect(config.initial_mode).toBe('bypass');
    expect(config.title_generation).toBe(false);
    expect(config.subagents).toEqual({
      enabled: true,
      cwd_policy: 'allowed_paths',
    });
    expect(config.agent).toBeUndefined();
    expect(config.models).toMatchObject({
      'benchmark-pro': {
        auth_scheme: 'bearer',
        http_headers: { 'X-Gateway-Route': 'benchmark' },
      },
    });
    expect(JSON.stringify(config)).not.toContain('api_key"');
    expect(await readFile(path.join(elloHome, 'mcp.json'), 'utf8')).toContain(
      '"servers"',
    );
  });

  it('uses the runtime switch for a clean no-subagent control', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-config-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });

    const files = await writeBenchmarkAgentConfig({
      elloHome: path.join(root, 'ello-home'),
      workspace,
      agent: ElloAgentSpecSchema.parse({
        ...agentFixture(),
        features: { subagents: false },
      }),
      snapshotPath: path.join(root, 'snapshot.json'),
    });
    const config = parse(await readFile(files.configPath, 'utf8')) as Record<
      string,
      unknown
    >;

    expect(config.subagents).toEqual({
      enabled: false,
      cwd_policy: 'allowed_paths',
    });
    expect(config.agent).toBeUndefined();
  });

  it('rejects the removed ptc feature configuration', () => {
    expect(() =>
      ElloAgentSpecSchema.parse({
        ...agentFixture(),
        features: { subagents: true, ptc: false },
      }),
    ).toThrow();
  });

  it('rejects project state that could override the isolated config', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-config-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(path.join(workspace, '.ello'), { recursive: true });

    await expect(
      writeBenchmarkAgentConfig({
        elloHome: path.join(root, 'ello-home'),
        workspace,
        agent: agentFixture(),
        snapshotPath: path.join(root, 'snapshot.json'),
      }),
    ).rejects.toThrow('must not contain Ello project state');
  });
});

function agentFixture() {
  return ElloAgentSpecSchema.parse({
    id: 'sample',
    displayName: 'Sample Ello',
    kind: 'ello',
    models: {
      'benchmark-pro': {
        protocol: 'anthropic',
        authScheme: 'bearer',
        apiModel: 'model-pro',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        httpHeaders: { 'X-Gateway-Route': 'benchmark' },
        contextWindow: 128000,
        maxOutputTokens: 16000,
        reasoningEffort: 'medium',
      },
      'benchmark-flash': {
        protocol: 'openai',
        endpoint: 'responses',
        apiModel: 'model-flash',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        contextWindow: 128000,
        maxOutputTokens: 8000,
        reasoningEffort: 'low',
      },
    },
    primaryModel: 'benchmark-pro',
    auxiliaryModel: 'benchmark-flash',
  });
}
