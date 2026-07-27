import { describe, expect, it } from 'vitest';

import {
  createAiSdkLanguageModel,
  createAnthropicProviderSettings,
  createOpenAiProviderSettings,
} from '../../src/features/model/providers/ai-sdk/ai-sdk-provider.js';

describe('Anthropic provider authentication', () => {
  it('maps bearer authentication to the SDK authToken setting', () => {
    expect(
      createAnthropicProviderSettings({
        protocol: 'anthropic',
        authScheme: 'bearer',
        modelId: 'deepseek-v4-pro-official',
        baseURL: 'https://api.example.test/anthropic/v1',
        apiKey: 'venus-token',
      }),
    ).toEqual({
      name: 'anthropic',
      baseURL: 'https://api.example.test/anthropic/v1',
      authToken: 'venus-token',
    });
  });

  it('maps api-key authentication to the SDK apiKey setting', () => {
    expect(
      createAnthropicProviderSettings({
        protocol: 'anthropic',
        authScheme: 'api-key',
        modelId: 'claude-test',
        baseURL: 'https://api.example.test/v1',
        apiKey: 'anthropic-key',
      }),
    ).toEqual({
      name: 'anthropic',
      baseURL: 'https://api.example.test/v1',
      apiKey: 'anthropic-key',
    });
  });

  it('passes configured custom headers to both provider factories', () => {
    const headers = { 'X-Gateway-Route': 'benchmark' };
    expect(
      createAnthropicProviderSettings({
        protocol: 'anthropic',
        authScheme: 'bearer',
        modelId: 'deepseek-v4-pro-official',
        baseURL: 'https://api.example.test/anthropic/v1',
        apiKey: 'venus-token',
        headers,
      }),
    ).toMatchObject({ authToken: 'venus-token', headers });
    expect(
      createOpenAiProviderSettings({
        protocol: 'openai-compatible',
        endpoint: 'chat',
        modelId: 'vendor-pro',
        baseURL: 'https://api.example.test/v1',
        apiKey: 'vendor-token',
        headers,
      }),
    ).toMatchObject({ apiKey: 'vendor-token', headers });
  });

  it('rejects custom headers that override provider authentication', () => {
    expect(() =>
      createAiSdkLanguageModel({
        protocol: 'anthropic',
        authScheme: 'bearer',
        modelId: 'claude-test',
        baseURL: 'https://api.example.test/v1',
        apiKey: 'key',
        headers: { authorization: 'Bearer another-key' },
      }),
    ).toThrow('must not override provider authentication header authorization');
  });

  it('rejects Anthropic model descriptors without an authentication scheme', () => {
    expect(() =>
      createAiSdkLanguageModel({
        protocol: 'anthropic',
        modelId: 'claude-test',
        baseURL: 'https://api.example.test/v1',
        apiKey: 'key',
      }),
    ).toThrow('requires an explicit authScheme');
  });
});
