import { describe, expect, it } from 'vitest';

import { mapAiSdkUsage } from '../../src/agent/engine/core/usage.js';

describe('AI SDK usage mapping', () => {
  it('读取 inputTokenDetails 中的 cache token', () => {
    expect(
      mapAiSdkUsage({
        inputTokens: 100,
        inputTokenDetails: {
          noCacheTokens: 20,
          cacheReadTokens: 70,
          cacheWriteTokens: 10,
        },
        outputTokens: 25,
      }),
    ).toEqual({
      requests: 1,
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 70,
      cacheWriteTokens: 10,
      toolCalls: 0,
    });
  });

  it('拒绝缺少 inputTokenDetails 的宽松 usage 对象', () => {
    expect(() =>
      mapAiSdkUsage({
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 70,
      }),
    ).toThrow('usage.inputTokenDetails must be an object');
  });
});
