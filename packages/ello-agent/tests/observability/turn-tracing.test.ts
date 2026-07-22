/**
 * 本文件验证 turn-tracing 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createTurnTracing } from '../../src/infra/telemetry/turn-tracing.js';

const originalPublicKey = process.env.LANGFUSE_PUBLIC_KEY;
const originalSecretKey = process.env.LANGFUSE_SECRET_KEY;

afterEach(() => {
  restoreEnvironment('LANGFUSE_PUBLIC_KEY', originalPublicKey);
  restoreEnvironment('LANGFUSE_SECRET_KEY', originalSecretKey);
});

describe('production turn tracing', () => {
  it('关闭时不要求凭证且不创建 recorder', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const tracing = createTurnTracing({ enabled: false }, 'thr_disabled');

    expect(tracing.eventRecorder).toBeUndefined();
    await expect(tracing.close()).resolves.toBeUndefined();
  });

  it('启用时缺少任一凭证立即失败，不静默退回关闭状态', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'public-test';
    delete process.env.LANGFUSE_SECRET_KEY;

    expect(() =>
      createTurnTracing(enabledConfig(), 'thr_missing_secret'),
    ).toThrow('LANGFUSE_SECRET_KEY is required');
  });

  it('完整配置创建真实 recorder，并可幂等关闭 exporter', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'public-test';
    process.env.LANGFUSE_SECRET_KEY = 'secret-test';
    const tracing = createTurnTracing(enabledConfig(), 'thr_traced');

    expect(tracing.eventRecorder).toBeDefined();
    await expect(tracing.close()).resolves.toBeUndefined();
    await expect(tracing.close()).resolves.toBeUndefined();
  });
});

function enabledConfig() {
  return {
    enabled: true as const,
    base_url: 'https://langfuse.example.test',
    environment: 'test',
    release: 'contract',
    content: 'metadata' as const,
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
