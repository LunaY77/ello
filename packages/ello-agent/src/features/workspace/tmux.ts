/**
 * 本文件负责 workspace feature 的“tmux”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { CommandError, run } from '../../infra/git.js';

/** 只管理绑定到 workspace 生命周期的 tmux session。 */
export class TmuxStore {
  /**
   * 校验 Workspace `tmux` 模块 的输入并返回已满足领域约束的值。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Workspace `tmux` 模块 的异步副作用完整提交后兑现，不返回业务值。
   *
   * Throws:
   * - 当 Workspace `tmux` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async assertAvailable(): Promise<void> {
    await run('tmux', ['-V']);
  }

  /**
   * 校验 Workspace `tmux` 模块 的输入并返回已满足领域约束的值。
   *
   * Args:
   * - `session`: `assertSessionAvailable` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Workspace `tmux` 模块 的异步副作用完整提交后兑现，不返回业务值。
   *
   * Throws:
   * - 当 Workspace `tmux` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async assertSessionAvailable(session: string): Promise<void> {
    if (await this.exists(session)) {
      throw new Error(`Tmux session already exists: ${session}`);
    }
  }

  /**
   * 执行 Workspace `tmux` 模块 定义的 `newSession` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `session`: `newSession` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
   *
   * Returns:
   * - Promise 在 Workspace `tmux` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async newSession(session: string, cwd: string): Promise<void> {
    await run('tmux', ['new-session', '-d', '-s', session, '-c', cwd]);
  }

  /**
   * 执行 Workspace `tmux` 模块 定义的 `renameSession` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `current`: `renameSession` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `next`: `renameSession` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Workspace `tmux` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async renameSession(current: string, next: string): Promise<void> {
    await run('tmux', ['rename-session', '-t', current, next]);
  }

  /**
   * 执行 Workspace `tmux` 模块 定义的 `killSession` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `session`: `killSession` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Workspace `tmux` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async killSession(session: string): Promise<'killed' | 'already_absent'> {
    if (!(await this.exists(session))) return 'already_absent';
    await run('tmux', ['kill-session', '-t', session]);
    return 'killed';
  }

  private async exists(session: string): Promise<boolean> {
    try {
      await run('tmux', ['has-session', '-t', session]);
      return true;
    } catch (error) {
      if (error instanceof CommandError && error.exitCode === 1) return false;
      throw error;
    }
  }
}
