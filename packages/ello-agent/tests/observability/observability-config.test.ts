/**
 * 本文件验证 observability-config 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { describe, expect, it } from 'vitest';

import { CodingAgentConfigSchema } from '../../src/features/config/schema.js';

describe('Langfuse observability config', () => {
  it('allows disabled tracing without valid connection fields', () => {
    const config = CodingAgentConfigSchema.parse({
      initial_mode: 'ask-before-changes',
      observability: {
        langfuse: {
          enabled: false,
          base_url: 42,
          content: 'not-validated-while-disabled',
        },
      },
    });

    expect(config.observability?.langfuse.enabled).toBe(false);
  });

  it('requires complete Langfuse configuration only when enabled', () => {
    expect(() =>
      CodingAgentConfigSchema.parse({
        initial_mode: 'ask-before-changes',
        observability: { langfuse: { enabled: true } },
      }),
    ).toThrow();
  });

  it('rejects an invalid explicit routing switch', () => {
    expect(() =>
      CodingAgentConfigSchema.parse({
        initial_mode: 'ask-before-changes',
        tools: { routing_enabled: 'yes' },
      }),
    ).toThrow('expected boolean');
  });
});
