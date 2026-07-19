import { describe, expect, it } from 'vitest';

import { describeConfigSettings } from '../../src/config/settings.js';

describe('config settings descriptors', () => {
  it('展平可编辑配置，排除独立资源和运行期字段', () => {
    const settings = describeConfigSettings(
      {
        active_profile: 'main',
        models: { openai: {} },
        profile: { main: {} },
        cwd: '/workspace',
        session_id: 'thr_1',
        initial_mode: 'ask-before-changes',
        allowed_paths: ['/workspace'],
        tools: { routing_enabled: false },
        context: { max_input_tokens: 160_000 },
        provider: {
          vault: {
            enabled: true,
            kind: 'openai',
            api_key_env: 'OPENAI_API_KEY',
          },
        },
        agent: {},
        projects: {},
      },
      [
        { name: 'defaults', data: {} },
        {
          name: 'global',
          data: {
            initial_mode: 'ask-before-changes',
            provider: { vault: { kind: 'openai' } },
          },
        },
        {
          name: 'project',
          data: { tools: { routing_enabled: false } },
        },
        { name: 'override', data: {} },
      ],
    );

    expect(settings.map((setting) => setting.id)).not.toEqual(
      expect.arrayContaining([
        'active_profile',
        'cwd',
        'models',
        'profile',
        'session_id',
      ]),
    );
    expect(settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'initial_mode',
          type: 'enum',
          source: 'global',
          effect: 'newThread',
        }),
        expect.objectContaining({
          id: 'allowed_paths',
          type: 'stringList',
        }),
        expect.objectContaining({
          id: 'tools.routing_enabled',
          type: 'boolean',
          source: 'project',
        }),
        expect.objectContaining({
          id: 'context.max_input_tokens',
          type: 'integer',
        }),
        expect.objectContaining({ id: 'agent', type: 'json' }),
        expect.objectContaining({ id: 'projects', type: 'json' }),
        expect.objectContaining({ id: 'observability', type: 'json' }),
      ]),
    );
  });

  it('敏感 provider 字段可盲写但不包含当前值', () => {
    const settings = describeConfigSettings(
      {
        provider: {
          vault: {
            kind: 'openai',
            api_key: 'must-not-leak',
            headers: { Authorization: 'must-not-leak' },
          },
        },
      },
      [
        { name: 'defaults', data: {} },
        {
          name: 'global',
          data: {
            provider: {
              vault: {
                api_key: 'must-not-leak',
                headers: { Authorization: 'must-not-leak' },
              },
            },
          },
        },
        { name: 'project', data: {} },
        { name: 'override', data: {} },
      ],
    );

    const secrets = settings.filter((setting) => setting.sensitive);
    expect(secrets.map((setting) => setting.id)).toEqual(
      expect.arrayContaining([
        'provider.vault.api_key',
        'provider.vault.api_key_env',
        'provider.vault.api_key_file',
        'provider.vault.headers',
        'provider.vault.options',
      ]),
    );
    expect(secrets.every((setting) => !('value' in setting))).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('must-not-leak');
  });
});
