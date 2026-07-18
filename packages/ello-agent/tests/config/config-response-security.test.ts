import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { globalConfigPath } from '../../src/config/index.js';
import type { ServerConnection } from '../../src/server/connection/server-connection.js';
import { sanitizeConfigForResponse } from '../../src/server/methods/config-response.js';
import { ServerServices } from '../../src/server/methods/server-services.js';
import type { ThreadManager } from '../../src/server/runtime/thread-manager.js';
import {
  createCodingStorage,
  type CodingStorage,
} from '../../src/storage/database/index.js';
import type { ThreadLogRepository } from '../../src/storage/threads/thread-log.js';

describe('config RPC credential boundary', () => {
  let previousHome: string | undefined;
  let home: string;
  let cwd: string;
  let services: ServerServices;
  let storage: CodingStorage;

  beforeEach(async () => {
    previousHome = process.env.ELLO_HOME;
    home = await mkdtemp(join(tmpdir(), 'ello-config-response-home-'));
    cwd = await mkdtemp(join(tmpdir(), 'ello-config-response-project-'));
    process.env.ELLO_HOME = home;
    storage = createCodingStorage();
    services = new ServerServices({
      threads: {} as ThreadManager,
      logs: {} as ThreadLogRepository,
      storage,
    });
    await writeFile(
      globalConfigPath(),
      [
        'initial_mode: ask-before-changes',
        'provider:',
        '  vault:',
        '    enabled: true',
        '    kind: openai',
        '    api_key: api-secret-value',
        '    api_key_file: /private/key-file',
        '    base_url: https://url-user:url-secret-value@api.example.test/v1?access_token=query-secret-value&region=cn',
        '    headers:',
        '      Authorization: Bearer auth-secret-value',
        '      X-Api-Key: header-secret-value',
        '      X-Public: visible-header-value',
        '    options:',
        '      access_token: access-secret-value',
        '      password: password-secret-value',
        '      client_secret: client-secret-value',
        '      private-key: private-key-secret-value',
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(async () => {
    await services.close();
    storage.close();
    if (previousHome === undefined) delete process.env.ELLO_HOME;
    else process.env.ELLO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('递归清洗凭证键，同时保留模型 token 参数和非敏感字段', () => {
    expect(
      sanitizeConfigForResponse({
        api_key: 'secret',
        apiKeyFile: '/secret-file',
        auth_headers: { arbitrary: 'secret' },
        headers: {
          Authorization: 'secret',
          'x-api-key': 'secret',
          'x-visible': 'public',
        },
        nested: [
          {
            accessToken: 'secret',
            password: 'secret',
            client_secret: 'secret',
            privateKey: 'secret',
            tokenBudget: 123,
            max_input_tokens: 456,
            model: 'openai/gpt-5.5',
            endpoint:
              'https://url-user:url-secret-value@api.example.test/v1?access_token=query-secret-value&region=cn',
          },
        ],
        profile: 'main',
      }),
    ).toEqual({
      nested: [
        {
          tokenBudget: 123,
          max_input_tokens: 456,
          model: 'openai/gpt-5.5',
          endpoint: 'https://api.example.test/v1?region=cn',
        },
      ],
      profile: 'main',
    });
  });

  it('config/read 的 merged config 与 includeSources 都不返回 credential', async () => {
    const response = await services.dispatch(
      {} as ServerConnection,
      'config/read',
      { cwd, includeSources: true },
    );

    expect(response).toMatchObject({
      config: {
        active_profile: 'main',
        provider: {
          vault: {
            enabled: true,
            kind: 'openai',
            base_url: 'https://api.example.test/v1?region=cn',
          },
        },
        models: { openai: { 'gpt-5.5': { provider: 'openai' } } },
        profile: { main: { models: { primary: 'openai/gpt-5.5' } } },
      },
      sources: expect.arrayContaining([
        expect.objectContaining({
          name: 'global',
          value: expect.objectContaining({
            provider: {
              vault: {
                enabled: true,
                kind: 'openai',
                base_url: 'https://api.example.test/v1?region=cn',
                options: {},
              },
            },
          }),
        }),
      ]),
    });
    expectCredentialValuesAbsent(response);
  });

  it('config/write 完成真实写入，但 response 不回显新旧 credential', async () => {
    const response = await services.dispatch(
      {} as ServerConnection,
      'config/write',
      {
        cwd,
        source: 'global',
        path: ['provider', 'vault', 'api_key'],
        value: 'rotated-secret-value',
        operation: 'set',
      },
    );

    expect(await readFile(globalConfigPath(), 'utf8')).toContain(
      'rotated-secret-value',
    );
    expect(response).toMatchObject({
      config: {
        active_profile: 'main',
        models: { openai: { 'gpt-5.5': { provider: 'openai' } } },
        profile: { main: { models: { primary: 'openai/gpt-5.5' } } },
      },
    });
    expectCredentialValuesAbsent(response);
    expect(JSON.stringify(response)).not.toContain('rotated-secret-value');
  });
});

function expectCredentialValuesAbsent(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const secret of [
    'api-secret-value',
    'auth-secret-value',
    'header-secret-value',
    'access-secret-value',
    'password-secret-value',
    'client-secret-value',
    'private-key-secret-value',
    'url-secret-value',
    'query-secret-value',
    '/private/key-file',
  ]) {
    expect(serialized).not.toContain(secret);
  }
}
