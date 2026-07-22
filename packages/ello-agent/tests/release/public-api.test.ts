/**
 * 本文件验证 public-api 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import * as agent from '../../src/index.js';

describe('@ello/agent public API', () => {
  it('只暴露 App Server 生命周期', () => {
    expect(Object.keys(agent).sort()).toEqual(['AgentServer', 'createApp']);
  });

  it('package exports 不包含 internal 子路径', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { readonly exports: Record<string, unknown> };
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      '.',
      './package.json',
      './protocol',
      './server-entry',
    ]);
  });
});
