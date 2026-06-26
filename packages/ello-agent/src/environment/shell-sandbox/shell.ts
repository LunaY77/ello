import type { Shell, ShellResult } from '../base.js';

import { CommandAction, type ShellPolicy } from './policy.js';

/**
 * 策略驱动的沙箱 shell, 包装底层 shell 并在执行前检查策略。
 *
 * Args:
 *   inner: 被包装的底层 Shell 实例。
 *   policy: 要应用的策略。
 */
export class SandboxShell implements Shell {
  constructor(
    private readonly inner: Shell,
    private readonly policy: ShellPolicy,
  ) {}

  /**
   * 在策略检查后执行命令。
   *
   * Returns:
   *   ShellResult; 策略拒绝或需要审批时返回 exitCode=1。
   */
  async run(
    command: string,
    options: { cwd?: string; timeout?: number } = {},
  ): Promise<ShellResult> {
    const [action, reason] = this.policy.evaluate(command);

    if (action === CommandAction.deny) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: reason
          ? `Command denied by policy: ${reason}`
          : 'Command denied by policy.',
      };
    }

    if (action === CommandAction.requireApproval) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: reason
          ? `Command requires approval: ${reason}`
          : 'Command requires approval.',
      };
    }

    return this.inner.run(command, options);
  }

  /** 关闭底层 shell。 */
  async close(): Promise<void> {
    await this.inner.close?.();
  }
}
