import { describe, expect, it, vi } from 'vitest';

import { Environment, createAgent } from '../index.js';

class CountingEnvironment extends Environment {
  enterCalls = 0;
  exitCalls = 0;
  private readonly setupDelayMs: number;

  constructor(options: { setupDelayMs?: number } = {}) {
    super();
    this.setupDelayMs = options.setupDelayMs ?? 0;
  }

  /** 初始化环境资源, 测试中只记录调用次数。 */
  protected async setup(): Promise<void> {
    this.enterCalls += 1;
    if (this.setupDelayMs > 0) {
      await delay(this.setupDelayMs);
    }
  }

  /** 清理环境资源, 测试中只记录调用次数。 */
  protected async teardown(): Promise<void> {
    this.exitCalls += 1;
  }
}

describe('AgentRuntime re-entrant lifecycle', () => {
  it('keeps resources until the outer exit', async () => {
    const env = new CountingEnvironment();
    const runtime = createAgent({ env });

    await runtime.enter();
    expect(runtime.entered).toBe(true);
    expect(runtime.enterCountValue).toBe(1);
    expect(runtime.ctx).not.toBeNull();

    await runtime.enter();
    expect(runtime.enterCountValue).toBe(2);
    expect(env.enterCalls).toBe(1);

    await runtime.exit();
    expect(runtime.enterCountValue).toBe(1);
    expect(runtime.ctx).not.toBeNull();
    expect(env.exitCalls).toBe(0);

    await runtime.exit();
    expect(runtime.entered).toBe(false);
    expect(runtime.enterCountValue).toBe(0);
    expect(runtime.ctx).toBeNull();
    expect(env.enterCalls).toBe(1);
    expect(env.exitCalls).toBe(1);
  });

  it('serializes concurrent enter calls', async () => {
    const env = new CountingEnvironment({ setupDelayMs: 5 });
    const runtime = createAgent({ env });

    await Promise.all([runtime.enter(), runtime.enter(), runtime.enter()]);

    expect(runtime.entered).toBe(true);
    expect(runtime.enterCountValue).toBe(3);
    expect(env.enterCalls).toBe(1);

    await Promise.all([runtime.exit(), runtime.exit(), runtime.exit()]);

    expect(runtime.entered).toBe(false);
    expect(runtime.enterCountValue).toBe(0);
    expect(env.exitCalls).toBe(1);
  });

  it('supports a single enter and exit', async () => {
    const env = new CountingEnvironment();
    const runtime = createAgent({ env });

    await runtime.enter();
    expect(runtime.entered).toBe(true);
    expect(runtime.ctx).not.toBeNull();

    await runtime.exit();
    expect(runtime.entered).toBe(false);
    expect(runtime.ctx).toBeNull();
  });

  it('releases the lifecycle lock when enter fails', async () => {
    const env = new CountingEnvironment();
    const runtime = createAgent({ env });
    const error = new Error('setup failed');
    vi.spyOn(env, 'enter').mockRejectedValueOnce(error);

    await expect(runtime.enter()).rejects.toThrow(error);

    await runtime.enter();
    expect(runtime.entered).toBe(true);
    await runtime.exit();
  });
});

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
