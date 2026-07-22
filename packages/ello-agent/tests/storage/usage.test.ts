/**
 * 本文件验证 usage 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { describe, expect, it } from 'vitest';

import { mapAiSdkUsage } from '../../src/features/agent/engine/result.js';

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
