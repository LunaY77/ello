/**
 * 本文件验证 App Server 进程入口接管第三方诊断输出，确保 stdio 协议通道不被日志污染。
 *
 * 测试只观察全局 warning hook 与标准流写入，不启动长期运行的 Server 资源。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAppServer } from '../../src/main.js';

const originalWarningLogger = globalThis.AI_SDK_LOG_WARNINGS;

afterEach(() => {
  globalThis.AI_SDK_LOG_WARNINGS = originalWarningLogger;
  vi.restoreAllMocks();
});

describe('App Server process diagnostics', () => {
  it('把 AI SDK warning 写入结构化 stderr，不污染 stdout', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    await expect(runAppServer([])).rejects.toThrow('--listen is required');
    const logger = globalThis.AI_SDK_LOG_WARNINGS;
    expect(logger).toBeTypeOf('function');
    if (typeof logger !== 'function') throw new Error('AI SDK logger missing.');
    logger({
      warnings: [{ type: 'other', message: 'reasoning skipped' }],
      provider: 'openai.responses',
      model: 'gpt-test',
    });

    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0] ?? '')).toMatchObject({
      level: 'warn',
      event: 'model.warning',
      provider: 'openai.responses',
      model: 'gpt-test',
      warning: { type: 'other', message: 'reasoning skipped' },
    });
  });
});
