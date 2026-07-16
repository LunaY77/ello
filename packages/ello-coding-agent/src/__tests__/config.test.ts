import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentToolContext } from '@ello/agent';
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
} from '../config/index.js';
import { makeApprovalPolicy } from '../permission/policy.js';
import { createProviderRegistry } from '../provider/index.js';
import { createCodingStorage } from '../storage/index.js';
import { createCodingTools } from '../tools/index.js';
import { parseYamlConfig, stringifyYamlConfig } from '../utils/yaml.js';

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
    if (previousHome === undefined) {
      delete process.env.ELLO_HOME;
    } else {
      process.env.ELLO_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('初始化时复制 YAML profile suite 模板', async () => {
    await ensureGlobalConfig();

    const globalConfig = await readFile(globalConfigPath(), 'utf8');
    expect(globalConfig).toContain('active_profile: main');
    expect(globalConfig).toContain('workspace:');
    expect(globalConfig).toContain('mount: ~/.ello');
    expect(globalConfig).toContain('provider:');
    expect(globalConfig).toContain('openai:');
    expect(globalConfig).toContain('anthropic:');
    expect(globalConfig).not.toContain('openai-compatible:');
    expect(globalConfig).toContain('profile:');
    expect(globalConfig).toContain('primary: openai/gpt-5.5');
    expect(globalConfig).toContain('compact: openai/gpt-5.4');
    expect(globalConfig).toContain('review: anthropic/claude-sonnet-4.6');
    expect(await readFile(globalMcpPath(), 'utf8')).toContain('"servers"');
  });

  it('默认配置只内置指定的 OpenAI 和 Anthropic 模型', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    try {
      const config = await loadCodingAgentConfig({ cwd });
      const registry = createProviderRegistry(config);

      expect(config.active_profile).toBe('main');
      expect(config.workspace.mount).toBe('~/.ello');
      expect(registry.getProvider('openai').apiKey).toBe('test-openai-key');
      expect(
        registry
          .listModels()
          .map((model) => model.ref)
          .sort(),
      ).toEqual([
        'anthropic/claude-haiku-4.5',
        'anthropic/claude-opus-4.6',
        'anthropic/claude-opus-4.7',
        'anthropic/claude-opus-4.8',
        'anthropic/claude-sonnet-4.6',
        'openai/gpt-5.4',
        'openai/gpt-5.5',
      ]);
      expect(registry.resolveRole('main', 'primary').ref).toBe(
        'openai/gpt-5.5',
      );
      expect(registry.resolveRole('main', 'compact').ref).toBe(
        'openai/gpt-5.4',
      );
      expect(registry.resolveRole('main', 'review').ref).toBe(
        'anthropic/claude-sonnet-4.6',
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it('按目标创建项目 YAML 配置文件', async () => {
    await ensureProjectConfig(cwd);

    expect(projectConfigPath(cwd).endsWith('config.yaml')).toBe(true);
    expect(await readFile(projectConfigPath(cwd), 'utf8')).toBe('');
  });

  it('round-trips provider/models/profile suite YAML', () => {
    const text = stringifyYamlConfig({
      active_profile: 'fast',
      provider: {
        hiyo: {
          enabled: true,
          kind: 'openai',
          api_key_env: 'HIYO_API_KEY',
          base_url: 'https://codex.hiyo.top',
          options: {},
          headers: { 'x-ello': '1' },
        },
      },
      models: {
        hiyo: {
          flash: customModel('hiyo', 'flash', 'chat'),
        },
      },
      profile: {
        fast: customProfile('hiyo/flash'),
      },
    });
    expect(text).toContain('provider:');
    expect(text).toContain('x-ello: "1"');
    expect(parseYamlConfig(text)).toMatchObject({
      active_profile: 'fast',
      provider: {
        hiyo: {
          base_url: 'https://codex.hiyo.top',
          headers: { 'x-ello': '1' },
        },
      },
      models: {
        hiyo: {
          flash: {
            provider: 'hiyo',
            endpoint: 'chat',
          },
        },
      },
      profile: {
        fast: {
          models: {
            primary: 'hiyo/flash',
          },
        },
      },
    });
  });

  it('从全局 profile suite 解析项目 provider/model', async () => {
    await writeProjectConfig({
      provider: {
        hiyo: {
          enabled: true,
          kind: 'openai',
          api_key_env: 'HIYO_API_KEY',
          base_url: 'https://codex.hiyo.top',
          headers: {},
          options: {},
        },
      },
      models: {
        hiyo: {
          fast: customModel('hiyo', 'fast', 'chat'),
          deep: customModel('hiyo', 'deep', 'responses'),
        },
      },
    });
    await writeGlobalConfig({
      active_profile: 'deep',
      profile: {
        deep: {
          models: {
            primary: 'hiyo/deep',
            small: 'hiyo/fast',
            compact: 'hiyo/fast',
            title: 'hiyo/fast',
            review: 'hiyo/deep',
          },
          settings: {
            primary: { reasoning_effort: 'high' },
            compact: { reasoning_effort: 'low' },
          },
        },
      },
    });

    const config = await loadCodingAgentConfig({ cwd });
    const registry = createProviderRegistry(config);

    expect(config.active_profile).toBe('deep');
    expect(registry.resolveRole('deep', 'primary').ref).toBe('hiyo/deep');
    expect(registry.resolveRole('deep', 'compact').ref).toBe('hiyo/fast');
    expect(
      registry.resolveRole('deep', 'primary').settings.reasoningEffort,
    ).toBe('high');
  });

  it('项目级 profile 配置直接报错', async () => {
    await writeProjectConfig({
      profile: {
        deep: customProfile('openai/gpt-5.5'),
      },
    });

    await expect(loadCodingAgentConfig({ cwd })).rejects.toThrow(
      'Project config must not define profile',
    );
  });

  it('项目级 active_profile 配置直接报错', async () => {
    await writeProjectConfig({ active_profile: 'main' });

    await expect(loadCodingAgentConfig({ cwd })).rejects.toThrow(
      'Project config must not define active_profile',
    );
  });

  it('项目级 default_agent 配置直接报错', async () => {
    await writeProjectConfig({ default_agent: 'plan' });

    await expect(loadCodingAgentConfig({ cwd })).rejects.toThrow(
      'Project config must not define default_agent',
    );
  });

  it('解析并应用 tools 与顶层运行配置', async () => {
    await writeGlobalConfig({
      active_profile: 'main',
      initial_mode: 'plan',
      tui: false,
      tools: {
        disabled: ['grep'],
        needApproval: ['bash'],
        routing_enabled: false,
        search: {
          result_limit: 4,
          max_result_bytes: 12000,
        },
      },
    });

    const config = await loadCodingAgentConfig({ cwd });

    expect(config.initialMode).toBe('plan');
    expect(config.tui).toBe(false);
    expect(config.tools).toEqual({
      disabled: ['grep'],
      needApproval: ['bash'],
      routing_enabled: false,
      search: {
        result_limit: 4,
        max_result_bytes: 12000,
      },
    });

    const storage = createCodingStorage({ databasePath: ':memory:' });
    try {
      const tools = createCodingTools({
        config,
        storage,
        taskBoardScope: { type: 'session', sessionId: 'config-test' },
        mode: () => ({
          mode: 'default',
          previousMode: null,
          source: 'resume',
          changedAt: new Date(0).toISOString(),
        }),
      });
      expect(tools.map((tool) => tool.name)).not.toContain('grep');
    } finally {
      storage.close();
    }

    const decide = makeApprovalPolicy(
      config,
      () => [
        {
          permission: 'bash',
          pattern: '**',
          action: 'allow',
          scope: 'session',
        },
      ],
      () => ({
        mode: 'default',
        previousMode: null,
        source: 'resume',
        changedAt: new Date(0).toISOString(),
      }),
    );
    expect(
      decide(
        {
          permission: 'bash',
          patterns: ['echo ok'],
          always: ['echo ok'],
          metadata: {
            kind: 'shell',
            command: 'echo ok',
            cwd,
            risk: 'normal',
          },
        },
        {} as AgentToolContext,
      ),
    ).toMatchObject({ action: 'required' });
  });

  it('tools 未配置时使用完整默认值', async () => {
    await writeGlobalText(['active_profile: main', '']);

    const config = await loadCodingAgentConfig({ cwd });

    expect(config.tools).toEqual({
      disabled: [],
      needApproval: [],
      routing_enabled: false,
      search: { result_limit: 6, max_result_bytes: 24000 },
    });
  });

  it('支持按 source 读取和 dotted path 写入', async () => {
    await setConfigValue(
      cwd,
      'project',
      'provider.openai.headers.x-ello',
      'yes',
    );

    expect(
      await getConfigValue(cwd, 'provider.openai.headers.x-ello', 'project'),
    ).toBe('yes');
    expect(await readFile(projectConfigPath(cwd), 'utf8')).toContain(
      'x-ello: yes',
    );
  });

  it('路径级写入 YAML 时保留未触达注释', async () => {
    await writeGlobalText([
      '# header comment',
      'active_profile: main',
      '# profile comment',
      'profile:',
      '  main:',
      '    label: Main',
      '    description: main profile',
      '    models:',
      '      primary: openai/gpt-5.5',
      '      small: openai/gpt-5.4',
      '      compact: openai/gpt-5.4',
      '      title: openai/gpt-5.4',
      '      review: anthropic/claude-sonnet-4.6',
      '',
    ]);

    await setConfigValue(cwd, 'global', 'active_profile', 'main');

    const text = await readFile(globalConfigPath(), 'utf8');
    expect(text).toContain('# header comment');
    expect(text).toContain('# profile comment');
  });

  it('支持原子写入 active_profile 与完整 profile map', async () => {
    await ensureGlobalConfig();
    const config = await setConfigValues(cwd, 'global', [
      { key: 'active_profile', value: 'deep' },
      {
        key: 'profile',
        value: {
          deep: customProfile('openai/gpt-5.5'),
        },
      },
    ]);

    expect(config.active_profile).toBe('deep');
    expect(Object.keys(config.profile)).toEqual(['deep']);
    expect(
      createProviderRegistry(config).resolveRole('deep', 'primary').ref,
    ).toBe('openai/gpt-5.5');
  });

  it('profile 引用未知模型时直接报错', async () => {
    await writeGlobalConfig({
      active_profile: 'bad',
      profile: {
        bad: customProfile('missing/model'),
      },
    });

    const config = await loadCodingAgentConfig({ cwd });
    expect(() => createProviderRegistry(config)).toThrow(
      'references unknown model',
    );
  });

  it('model table provider 与路径不一致时直接报错', async () => {
    await writeProjectConfig({
      models: {
        openai: {
          bad: {
            ...customModel('anthropic', 'bad', 'responses'),
            temperature: false,
            reasoning: false,
          },
        },
      },
    });
    await writeGlobalConfig({
      active_profile: 'bad',
      profile: {
        bad: customProfile('openai/bad'),
      },
    });

    const config = await loadCodingAgentConfig({ cwd });
    expect(() => createProviderRegistry(config)).toThrow(
      'declares provider anthropic; expected openai',
    );
  });

  it('支持用户自定义 OpenAI-compatible provider 与模型', async () => {
    await writeProjectConfig({
      provider: {
        gateway: {
          enabled: true,
          kind: 'openai-compatible',
          api_key_env: 'GATEWAY_API_KEY',
          base_url: 'https://gateway.example.test/v1',
          headers: {},
          options: {},
        },
      },
      models: {
        gateway: {
          'deepseek-v4-flash': customModel(
            'gateway',
            'deepseek-v4-flash',
            'chat',
          ),
        },
      },
    });
    await writeGlobalConfig({
      active_profile: 'gateway',
      profile: {
        gateway: customProfile('gateway/deepseek-v4-flash'),
      },
    });

    const registry = createProviderRegistry(
      await loadCodingAgentConfig({ cwd }),
    );

    expect(registry.getModel('gateway/deepseek-v4-flash').providerKind).toBe(
      'openai-compatible',
    );
    expect(() =>
      registry.resolveLanguageModel('gateway/deepseek-v4-flash'),
    ).not.toThrow();
  });

  it('用户自定义模型可只声明真实 API 映射和必要能力', async () => {
    await writeProjectConfig({
      provider: {
        venus: {
          enabled: true,
          kind: 'openai-compatible',
          api_key_env: 'OPENAI_API_KEY',
          base_url: 'https://venus.example.test/v1',
          headers: {
            'Venus-Sticky-Routing': 'token',
          },
        },
      },
      models: {
        venus: {
          deepseek: {
            provider: 'venus',
            api_id: 'deepseek-v4-flash',
            endpoint: 'chat',
            cost: 'zeroCost',
            tool_call: true,
          },
        },
      },
    });
    await writeGlobalConfig({
      active_profile: 'venus',
      profile: {
        venus: customProfile('venus/deepseek'),
      },
    });

    const registry = createProviderRegistry(
      await loadCodingAgentConfig({ cwd }),
    );
    const model = registry.getModel('venus/deepseek');

    expect(model.limit).toEqual({ context: 128000, output: 16000 });
    expect(model.pricing?.input).toBe(0);
    expect(model.capabilities.input).toEqual(['text']);
    expect(model.capabilities.output).toEqual(['text']);
    expect(model.capabilities.reasoning).toBe(false);
    expect(model.capabilities.toolCall).toBe(true);
  });

  async function writeProjectConfig(value: Record<string, unknown>) {
    await mkdir(path.dirname(projectConfigPath(cwd)), { recursive: true });
    await writeFile(projectConfigPath(cwd), stringifyYamlConfig(value), 'utf8');
  }

  async function writeGlobalConfig(value: Record<string, unknown>) {
    await mkdir(path.dirname(globalConfigPath()), { recursive: true });
    await writeFile(
      globalConfigPath(),
      stringifyYamlConfig({ initial_mode: 'default', ...value }),
      'utf8',
    );
  }

  async function writeGlobalText(lines: readonly string[]) {
    await mkdir(path.dirname(globalConfigPath()), { recursive: true });
    await writeFile(
      globalConfigPath(),
      ['initial_mode: default', ...lines].join('\n'),
      'utf8',
    );
  }
});

function customModel(
  provider: string,
  id: string,
  endpoint: 'chat' | 'responses',
) {
  return {
    provider,
    api_id: id,
    endpoint,
    status: 'active',
    context: 128000,
    output: 16000,
    cost: {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    },
    temperature: true,
    reasoning: true,
    tool_call: true,
    input_modalities: ['text'],
    output_modalities: ['text'],
    headers: {},
    options: {},
    variants: {},
  };
}

function customProfile(model: string) {
  return {
    models: {
      primary: model,
      small: model,
      compact: model,
      title: model,
      review: model,
    },
    settings: {
      primary: { reasoning_effort: 'low' },
    },
  };
}
