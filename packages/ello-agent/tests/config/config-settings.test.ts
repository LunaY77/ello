/**
 * 本文件验证配置项描述只暴露可编辑字段及其生效范围。
 */
import { describe, expect, it } from 'vitest';

import { describeConfigSettings } from '../../src/features/config/settings.js';

describe('config settings descriptors', () => {
  it('excludes the model directory while exposing the two global references', () => {
    const settings = describeConfigSettings(
      {
        models: { pro: { api_model: 'model-pro' } },
        primary_model: 'pro',
        auxiliary_model: 'flash',
        cwd: '/workspace',
        session_id: 'thr_1',
        initial_mode: 'ask-before-changes',
        title_generation: false,
        allowed_paths: ['/workspace'],
        subagents: { enabled: true, cwd_policy: 'workspace' },
        commands: { search: { result_limit: 6 } },
        context: { max_input_tokens: 160_000 },
        agent: { reviewer: { model: 'primary_model' } },
        projects: {},
      },
      [
        { name: 'defaults', data: {} },
        {
          name: 'global',
          data: {
            primary_model: 'pro',
            auxiliary_model: 'flash',
            initial_mode: 'ask-before-changes',
            subagents: { enabled: true, cwd_policy: 'workspace' },
          },
        },
        {
          name: 'project',
          data: { commands: { search: { result_limit: 6 } } },
        },
        { name: 'override', data: {} },
      ],
    );

    expect(settings.map((setting) => setting.id)).not.toEqual(
      expect.arrayContaining(['cwd', 'models', 'session_id']),
    );
    expect(settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'primary_model',
          value: 'pro',
          source: 'global',
        }),
        expect.objectContaining({
          id: 'auxiliary_model',
          value: 'flash',
          source: 'global',
        }),
        expect.objectContaining({
          id: 'initial_mode',
          type: 'enum',
          source: 'global',
          effect: 'newThread',
        }),
        expect.objectContaining({ id: 'allowed_paths', type: 'stringList' }),
        expect.objectContaining({
          id: 'subagents.enabled',
          type: 'boolean',
          value: true,
          source: 'global',
        }),
        expect.objectContaining({
          id: 'subagents.cwd_policy',
          type: 'enum',
          value: 'workspace',
          source: 'global',
        }),
        expect.objectContaining({
          id: 'title_generation',
          type: 'boolean',
          effect: 'newThread',
        }),
        expect.objectContaining({
          id: 'commands.search.result_limit',
          type: 'integer',
          source: 'project',
        }),
        expect.objectContaining({
          id: 'context.max_input_tokens',
          type: 'integer',
        }),
        expect.objectContaining({ id: 'agent.reviewer.model', type: 'enum' }),
        expect.objectContaining({ id: 'projects', type: 'json' }),
        expect.objectContaining({ id: 'observability', type: 'json' }),
      ]),
    );
  });
});
