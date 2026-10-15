/**
 * 验证配置文件初始化、分层加载、模型引用与跨字段校验的公开契约。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureGlobalConfig,
  ensureProjectConfig,
  getConfigValue,
  globalConfigPath,
  globalMcpPath,
  loadCodingAgentConfig,
  projectConfigPath,
  setConfigValue,
  setConfigValues,
  writeConfigPath,
} from '../../src/features/config/index.js';
import {
  parseYamlConfig,
  stringifyYamlConfig,
} from '../../src/features/config/yaml.js';
import { createModelRegistry } from '../../src/features/model/providers/catalog/index.js';

describe('loadCodingAgentConfig', () => {
  let previousHome: string | undefined;
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    previousHome = process.env.ELLO_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'ello-home-'));
    process.env.ELLO_HOME = home;
    cwd = await mkdtemp(path.join(tmpdir(), 'ello-config-'));
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.ELLO_HOME;
    else process.env.ELLO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('initializes a named model directory and two explicit references', async () => {
    await ensureGlobalConfig();

    const globalConfig = await readFile(globalConfigPath(), 'utf8');
    expect(globalConfig).toContain('models:');
    expect(globalConfig).toContain('primary_model: openai-gpt-5.5');
    expect(globalConfig).toContain('auxiliary_model: openai-gpt-5.4');
    expect(globalConfig).not.toContain('active_profile');
    expect(globalConfig).not.toContain('\nprofile:');
    expect(await readFile(globalMcpPath(), 'utf8')).toContain('"servers"');
  });

  it('resolves a selected reference through the complete model directory', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    try {
      const config = await loadCodingAgentConfig({ cwd });
      const registry = createModelRegistry(config);

      expect(config.primary_model).toBe('openai-gpt-5.5');
      expect(config.auxiliary_model).toBe('openai-gpt-5.4');
      expect(config.context).toMatchObject({
        max_input_tokens: 1_000_000,
        prompt_mode: 'rapid',
        compaction: { threshold_percent: 90 },
      });
      expect(registry.listModels().map((model) => model.name)).toEqual([
        'openai-gpt-5.4',
        'openai-gpt-5.5',
      ]);
      expect(registry.resolveSelector('primary_model')).toMatchObject({
        name: 'openai-gpt-5.5',
        apiModel: 'gpt-5.5',
        protocol: 'openai',
        endpoint: 'responses',
      });
      expect(registry.resolveSelector('auxiliary_model')).toMatchObject({
        name: 'openai-gpt-5.4',
        apiModel: 'gpt-5.4',
      });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('permits both references to name the same explicit model', async () => {
    await writeGlobalConfig({
      models: { solo: model('openai', 'solo', 'responses') },
      primary_model: 'solo',
      auxiliary_model: 'solo',
    });

    await expect(loadCodingAgentConfig({ cwd })).resolves.toMatchObject({
      primary_model: 'solo',
      auxiliary_model: 'solo',
    });
  });

  it('enables reasoning at medium effort when a model omits the setting', async () => {
    const withoutReasoning = model('anthropic', 'reasoning-default');
    const { reasoning_effort: _removed, ...modelConfig } = withoutReasoning;
    await writeGlobalConfig({
      models: { defaulted: modelConfig },
      primary_model: 'defaulted',
      auxiliary_model: 'defaulted',
    });

    await expect(loadCodingAgentConfig({ cwd })).resolves.toMatchObject({
      models: { defaulted: { reasoning_effort: 'medium' } },
    });
  });

  it('defaults automatic compaction to ninety percent', async () => {
    await writeGlobalConfig({
      models: { defaulted: model('openai', 'defaulted', 'responses') },
      primary_model: 'defaulted',
      auxiliary_model: 'defaulted',
    });

    await expect(loadCodingAgentConfig({ cwd })).resolves.toMatchObject({
      context: { compaction: { threshold_percent: 90 } },
    });
  });

  it.each(['rapid', 'thorough'] as const)(
    'accepts primary prompt mode %s',
    async (promptMode) => {
      await writeGlobalConfig({
        models: { selected: model('openai', 'selected', 'responses') },
        primary_model: 'selected',
        auxiliary_model: 'selected',
        context: { prompt_mode: promptMode },
      });

      await expect(loadCodingAgentConfig({ cwd })).resolves.toMatchObject({
        context: { prompt_mode: promptMode },
      });
    },
  );

  it.each([
    { system_prompt_profile: 'coding' },
    { context: { system_prompt_profile: 'balanced' } },
  ])('rejects removed prompt profile configuration %#', async (removed) => {
    await writeGlobalConfig({
      models: { selected: model('openai', 'selected', 'responses') },
      primary_model: 'selected',
      auxiliary_model: 'selected',
      ...removed,
    });

    await expect(loadCodingAgentConfig({ cwd })).rejects.toThrow(
      'system_prompt_profile',
    );
  });

  it.each([0, 101])(
    'rejects automatic compaction threshold percent %s',
    async (thresholdPercent) => {
      await writeGlobalConfig({
        models: { invalid: model('openai', 'invalid', 'responses') },
        primary_model: 'invalid',
        auxiliary_model: 'invalid',
        context: {
          compaction: { threshold_percent: thresholdPercent },
        },
      });

      await expect(loadCodingAgentConfig({ cwd })).rejects.toThrow(
        'threshold_percent',
      );
    },
  );

  it('round-trips named models without provider or profile suites', () => {
    const pro = {
      ...model('anthropic', 'vendor-pro'),
      http_headers: { 'X-Gateway-Route': 'benchmark' },
    };
    const text = stringifyYamlConfig({
      models: {
        pro,
        flash: model('openai-compatible', 'vendor-flash', 'chat'),
      },
      primary_model: 'pro',
      auxiliary_model: 'flash',
    });

    expect(parseYamlConfig(text)).toEqual({
      models: {
        pro,
        flash: model('openai-compatible', 'vendor-flash', 'chat'),
      },
      primary_model: 'pro',
      auxiliary_model: 'flash',
    });
  });

  it('rejects project model configuration and default agent selection', async () => {
    for (const key of [
      'models',
      'primary_model',
      'auxiliary_model',
      'default_agent',
    ] as const) {
      await writeProjectConfig({ [key]: key === 'models' ? {} : 'value' });
      await expect(loadCodingAgentConfig({ cwd })).rejects.toThrow(
        `Project config must not define ${key}`,
      );
    }
  });

  it('rejects legacy profile fields and malformed protocol branches', async () => {
    await writeGlobalConfig({ profile: { main: {} } });
    await expect(loadCodingAgentConfig({ cwd })).rejects.toThrow('profile');

    await writeGlobalConfig({
      models: {
        invalidOpenAi: {
          ...model('openai', 'invalid', 'responses'),
          endpoint: undefined,
        },
      },
      primary_model: 'invalidOpenAi',
      auxiliary_model: 'invalidOpenAi',
    });
    await expect(loadCodingAgentConfig({ cwd })).rejects.toThrow('endpoint');

    await writeGlobalConfig({
      models: {
        invalidAnthropic: {
          ...model('anthropic', 'invalid'),
          endpoint: 'chat',
        },
      },
      primary_model: 'invalidAnthropic',
      auxiliary_model: 'invalidAnthropic',
    });
    await expect(loadCodingAgentConfig({ cwd })).rejects.toThrow('endpoint');

    await writeGlobalConfig({
      models: {
        invalidAnthropic: {
          ...model('anthropic', 'invalid'),
          auth_scheme: undefined,
        },
      },
      primary_model: 'invalidAnthropic',
      auxiliary_model: 'invalidAnthropic',
    });
    await expect(loadCodingAgentConfig({ cwd })).rejects.toThrow('auth_scheme');

    await writeGlobalConfig({
      models: {
        invalidHeader: {
          ...model('anthropic', 'invalid'),
          auth_scheme: 'bearer',
          http_headers: { Authorization: 'Bearer another-key' },
        },
      },
      primary_model: 'invalidHeader',
      auxiliary_model: 'invalidHeader',
    });
    await expect(loadCodingAgentConfig({ cwd })).rejects.toThrow(
      'must not override provider authentication header authorization',
    );
  });

  it('rejects an unknown reference before committing a config write', async () => {
    await ensureGlobalConfig();
    const before = await readFile(globalConfigPath(), 'utf8');

    await expect(
      setConfigValue(cwd, 'global', 'primary_model', 'missing'),
    ).rejects.toThrow('references unknown model');
    await expect(readFile(globalConfigPath(), 'utf8')).resolves.toBe(before);
  });

  it('writes both model references atomically and reads dotted model fields', async () => {
    await ensureGlobalConfig();
    const config = await setConfigValues(cwd, 'global', [
      { key: 'primary_model', value: 'openai-gpt-5.4' },
      { key: 'auxiliary_model', value: 'openai-gpt-5.5' },
    ]);
    expect(config.primary_model).toBe('openai-gpt-5.4');
    expect(await getConfigValue(cwd, 'primary_model')).toBe('openai-gpt-5.4');

    await expect(
      writeConfigPath(
        cwd,
        'global',
        ['models', 'openai-gpt-5.5', 'max_output_tokens'],
        { type: 'set', value: 500_000 },
      ),
    ).rejects.toThrow('must not exceed context_window');
  });

  it('creates an empty project config file', async () => {
    await ensureProjectConfig(cwd);
    expect(projectConfigPath(cwd).endsWith('config.yaml')).toBe(true);
    expect(await readFile(projectConfigPath(cwd), 'utf8')).toBe('');
  });

  async function writeProjectConfig(value: Record<string, unknown>) {
    await mkdir(path.dirname(projectConfigPath(cwd)), { recursive: true });
    await writeFile(projectConfigPath(cwd), stringifyYamlConfig(value), 'utf8');
  }

  async function writeGlobalConfig(value: Record<string, unknown>) {
    await mkdir(path.dirname(globalConfigPath()), { recursive: true });
    await writeFile(
      globalConfigPath(),
      stringifyYamlConfig({ initial_mode: 'ask-before-changes', ...value }),
      'utf8',
    );
  }
});

function model(
  protocol: 'openai' | 'anthropic' | 'openai-compatible',
  apiModel: string,
  endpoint?: 'responses' | 'chat',
) {
  return {
    protocol,
    ...(protocol === 'anthropic'
      ? { auth_scheme: 'api-key' as const }
      : { endpoint }),
    api_model: apiModel,
    base_url: 'https://api.example.test/v1',
    api_key_env: 'TEST_API_KEY',
    context_window: 128_000,
    max_output_tokens: 16_000,
    reasoning_effort: 'medium',
  };
}
