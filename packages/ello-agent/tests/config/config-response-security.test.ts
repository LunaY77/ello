import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createConfigFeature,
  globalConfigPath,
  sanitizeConfigForResponse,
} from '../../src/features/config/index.js';
import { parseClientResult } from '../../src/protocol/v1/index.js';
import { createTestPeer, invokeServiceRoute } from '../support/rpc.js';

describe('config RPC credential boundary', () => {
  let previousHome: string | undefined;
  let home: string;
  let cwd: string;
  let services: ReturnType<typeof createConfigFeature>;

  beforeEach(async () => {
    previousHome = process.env.ELLO_HOME;
    home = await mkdtemp(join(tmpdir(), 'ello-config-response-home-'));
    cwd = await mkdtemp(join(tmpdir(), 'ello-config-response-project-'));
    process.env.ELLO_HOME = home;
    services = createConfigFeature();
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.ELLO_HOME;
    else process.env.ELLO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('recursively removes credential values from arbitrary response data', () => {
    expect(
      sanitizeConfigForResponse({
        api_key: 'secret',
        headers: { Authorization: 'secret', 'x-visible': 'public' },
        nested: {
          accessToken: 'secret',
          endpoint:
            'https://url-user:url-secret@api.example.test/v1?access_token=query-secret&region=cn',
          api_model: 'gpt-5.5',
        },
      }),
    ).toEqual({
      nested: {
        endpoint: 'https://api.example.test/v1?region=cn',
        api_model: 'gpt-5.5',
      },
    });
  });

  it('returns only the named model directory and global references', async () => {
    const response = await invokeServiceRoute(
      services,
      createTestPeer(),
      'config/read',
      { cwd, includeSources: true },
    );
    expect(response).toMatchObject({
      config: {
        primary_model: 'openai-gpt-5.5',
        auxiliary_model: 'openai-gpt-5.4',
        models: {
          'openai-gpt-5.5': {
            protocol: 'openai',
            endpoint: 'responses',
            api_model: 'gpt-5.5',
          },
        },
      },
      sources: expect.arrayContaining([
        expect.objectContaining({ name: 'global' }),
      ]),
    });
    expect(JSON.stringify(response)).not.toContain('api-secret-value');
  });

  it('exposes settings metadata without a Profile or provider catalog', async () => {
    const response = await invokeServiceRoute(
      services,
      createTestPeer(),
      'config/settings',
      { cwd },
    );
    expect(() => parseClientResult('config/settings', response)).not.toThrow();
    expect(response).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ id: 'primary_model', value: 'openai-gpt-5.5' }),
        expect.objectContaining({ id: 'auxiliary_model', value: 'openai-gpt-5.4' }),
      ]),
    });
    expect(JSON.stringify(response)).not.toContain('active_profile');
    expect(JSON.stringify(response)).not.toContain('provider.');
  });

  it('writes a global model reference without creating thread-level state', async () => {
    const response = await invokeServiceRoute(
      services,
      createTestPeer(),
      'config/write',
      {
        cwd,
        source: 'global',
        path: ['primary_model'],
        value: 'openai-gpt-5.4',
        operation: 'set',
      },
    );

    expect(await readFile(globalConfigPath(), 'utf8')).toContain(
      'primary_model: openai-gpt-5.4',
    );
    expect(response).toMatchObject({
      config: {
        primary_model: 'openai-gpt-5.4',
        auxiliary_model: 'openai-gpt-5.4',
      },
    });
  });
});
