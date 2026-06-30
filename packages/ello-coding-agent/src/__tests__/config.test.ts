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
} from '../config/index.js';
import { parseTomlConfig, stringifyTomlConfig } from '../utils/toml.js';

describe('loadCodingAgentConfig', () => {
  let oldHome: string | undefined;
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    oldHome = process.env.ELLO_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'ello-home-'));
    process.env.ELLO_HOME = home;
    cwd = await mkdtemp(path.join(tmpdir(), 'ello-config-'));
  });

  afterEach(async () => {
    if (oldHome === undefined) {
      delete process.env.ELLO_HOME;
    } else {
      process.env.ELLO_HOME = oldHome;
    }
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('初始化时从包内 templates 复制全局配置资产', async () => {
    await ensureGlobalConfig();

    const globalConfig = await readFile(globalConfigPath(), 'utf8');
    expect(globalConfig).toContain('default_model_profile = "gpt-5.5"');
    expect(globalConfig).toContain('[model_profiles."gpt-5.5"]');
    expect(globalConfig).toContain('[model_profiles."gpt-5.4"]');
    expect(globalConfig).toContain('model = "openai-responses:gpt-5.5"');
    expect(globalConfig).toContain('model = "openai-responses:gpt-5.4"');
    expect(globalConfig).toContain('# [ello]');
    expect(globalConfig).toContain('# [tools]');
    expect(globalConfig).toContain('# needApproval = ["bash", "web_fetch"]');
    expect(globalConfig).toContain(
      'protocols = ["openai-chat", "openai-responses"]',
    );
    expect(globalConfig).not.toContain('modelCandidates');
    expect(globalConfig).not.toContain('# model_profile =');
    expect(globalConfig).not.toContain('# model_reasoning_effort = "medium"');
    expect(globalConfig).not.toContain('# personality = "pragmatic"');
    expect(globalConfig).not.toContain('preferred_auth_method');
    expect(globalConfig).not.toContain('wire_api');
    expect(await readFile(globalMcpPath(), 'utf8')).toContain('"servers"');
  });

  it('默认模板解析后可以直接得到 openai 模型配置', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    try {
      const config = await loadCodingAgentConfig({ cwd });

      expect(config.default_model_profile).toBe('gpt-5.5');
      expect(config.model_provider).toBe('openai');
      expect(config.model).toBe('openai-responses:gpt-5.5');
      expect(config.modelCandidates).toEqual([
        'openai-responses:gpt-5.5',
        'openai-responses:gpt-5.4',
      ]);
      expect(config.apiKey).toBe('test-openai-key');
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it('按目标创建项目配置文件', async () => {
    await ensureProjectConfig(cwd);

    expect(await readFile(projectConfigPath(cwd), 'utf8')).toBe('');
  });

  it('accepts custom http headers from explicit config', async () => {
    const config = await loadCodingAgentConfig({
      model: 'fake:test',
      httpHeaders: { 'x-ello-test': 'yes' },
    });

    expect(config.httpHeaders).toEqual({ 'x-ello-test': 'yes' });
  });

  it('round-trips a TOML config object', () => {
    const text = stringifyTomlConfig({
      default_model_profile: 'fast',
      model_profiles: {
        fast: {
          model_provider: 'hiyo',
          model: 'openai-chat:gpt-5.5-mini',
          model_reasoning_effort: 'low',
          personality: 'pragmatic',
        },
      },
      model_providers: {
        hiyo: {
          base_url: 'https://codex.hiyo.top',
          protocols: ['openai-chat', 'openai-responses'],
          http_headers: { 'x-ello': '1' },
        },
      },
      inline: { enabled: true, values: [1, 2] },
    });
    expect(text).toContain('[model_providers.hiyo.http_headers]');
    expect(parseTomlConfig(text)).toMatchObject({
      default_model_profile: 'fast',
      model_profiles: {
        fast: {
          model_provider: 'hiyo',
          model: 'openai-chat:gpt-5.5-mini',
          model_reasoning_effort: 'low',
          personality: 'pragmatic',
        },
      },
      model_providers: {
        hiyo: {
          base_url: 'https://codex.hiyo.top',
          protocols: ['openai-chat', 'openai-responses'],
          http_headers: { 'x-ello': '1' },
        },
      },
      inline: { enabled: true, values: [1, 2] },
    });
  });

  it('命令行 override 可以直接覆盖 profile 派生出的模型', async () => {
    await mkdir(path.join(cwd, '.ello'), { recursive: true });
    await writeFile(
      projectConfigPath(cwd),
      [
        'default_model_profile = "deep"',
        '',
        '[model_profiles.deep]',
        'model_provider = "hiyo"',
        'model = "openai-responses:gpt-5.5"',
        '',
        '[model_providers.hiyo]',
        'base_url = "https://codex.hiyo.top"',
        'protocols = ["openai-chat", "openai-responses"]',
        '',
        '[model_providers.hiyo.http_headers]',
        'x-ello = "1"',
        '',
      ].join('\n'),
      'utf8',
    );

    const config = await loadCodingAgentConfig({
      cwd,
      model: 'openai-chat:override',
    });

    expect(config.model).toBe('openai-chat:override');
    expect(config.model_provider).toBe('hiyo');
    expect(config.baseUrl).toBe('https://codex.hiyo.top');
    expect(config.httpHeaders).toEqual({ 'x-ello': '1' });
  });

  it('从选中的 model profile 派生模型、provider 和候选模型', async () => {
    await mkdir(path.join(cwd, '.ello'), { recursive: true });
    await writeFile(
      projectConfigPath(cwd),
      [
        'default_model_profile = "deep"',
        '',
        '[model_profiles.fast]',
        'model_provider = "hiyo"',
        'model = "openai-chat:gpt-5.5-mini"',
        'model_reasoning_effort = "low"',
        '',
        '[model_profiles.deep]',
        'model_provider = "hiyo"',
        'model = "openai-responses:gpt-5.5"',
        'model_reasoning_effort = "high"',
        'personality = "pragmatic"',
        '',
        '[model_providers.hiyo]',
        'base_url = "https://codex.hiyo.top"',
        '',
      ].join('\n'),
      'utf8',
    );

    const config = await loadCodingAgentConfig({ cwd });

    expect(config.default_model_profile).toBe('deep');
    expect(config.model_provider).toBe('hiyo');
    expect(config.model).toBe('openai-responses:gpt-5.5');
    expect(config.model_reasoning_effort).toBe('high');
    expect(config.personality).toBe('pragmatic');
    expect(config.modelCandidates).toEqual([
      'openai-chat:gpt-5.5-mini',
      'openai-responses:gpt-5.5',
    ]);
    expect(config.baseUrl).toBe('https://codex.hiyo.top');
  });

  it('解析并应用 tools 配置', async () => {
    await mkdir(path.join(cwd, '.ello'), { recursive: true });
    await writeFile(
      projectConfigPath(cwd),
      [
        '[tools]',
        'disabled = ["web_fetch"]',
        'needApproval = ["bash"]',
        '',
      ].join('\n'),
      'utf8',
    );

    const config = await loadCodingAgentConfig({ cwd });

    expect(config.tools).toEqual({
      disabled: ['web_fetch'],
      needApproval: ['bash'],
    });
  });

  it('解析 [ello] 命名空间中的运行配置', async () => {
    await writeFile(
      globalConfigPath(),
      [
        'default_model_profile = "fast"',
        '',
        '[model_profiles.fast]',
        'model_provider = "openai"',
        'model = "openai-responses:gpt-5.5"',
        '',
        '[model_providers.openai]',
        'env_key = "OPENAI_API_KEY"',
        '',
        '[ello]',
        'approvalMode = "plan"',
        'tui = false',
        '',
        '[ello.tools]',
        'disabled = ["web_fetch"]',
        'needApproval = ["bash"]',
        '',
      ].join('\n'),
      'utf8',
    );

    const config = await loadCodingAgentConfig({ cwd });

    expect(config.approvalMode).toBe('plan');
    expect(config.tui).toBe(false);
    expect(config.tools).toEqual({
      disabled: ['web_fetch'],
      needApproval: ['bash'],
    });
  });

  it('按 project/overrides 优先级合并配置', async () => {
    await mkdir(path.join(cwd, '.ello'), { recursive: true });
    await writeFile(
      projectConfigPath(cwd),
      'model = "project:model"\n',
      'utf8',
    );
    const config = await loadCodingAgentConfig({
      cwd,
      model: 'override:model',
    });

    expect(config.model).toBe('override:model');
  });

  it('支持按 source 读取和 dotted path 写入', async () => {
    await setConfigValue(
      cwd,
      'project',
      'model_providers.hiyo.http_headers.x-ello',
      'yes',
    );

    expect(
      await getConfigValue(
        cwd,
        'model_providers.hiyo.http_headers.x-ello',
        'project',
      ),
    ).toBe('yes');
    expect(await readFile(projectConfigPath(cwd), 'utf8')).toContain(
      '[model_providers.hiyo.http_headers]',
    );
  });

  it('支持 Codex 风格 projects path 表写入', async () => {
    await setConfigValue(
      cwd,
      'global',
      'projects."/data/workspace/example".trust_level',
      'trusted',
    );

    expect(
      await getConfigValue(
        cwd,
        'projects."/data/workspace/example".trust_level',
        'global',
      ),
    ).toBe('trusted');
    expect(await readFile(globalConfigPath(), 'utf8')).toContain(
      '[projects."/data/workspace/example"]',
    );
  });
});
