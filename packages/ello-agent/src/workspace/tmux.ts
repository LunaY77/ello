import { CommandError, run } from './git.js';

/** 只管理绑定到 workspace 生命周期的 tmux session。 */
export class TmuxStore {
  async assertAvailable(): Promise<void> {
    await run('tmux', ['-V']);
  }

  async assertSessionAvailable(session: string): Promise<void> {
    if (await this.exists(session)) {
      throw new Error(`Tmux session already exists: ${session}`);
    }
  }

  async newSession(session: string, cwd: string): Promise<void> {
    await run('tmux', ['new-session', '-d', '-s', session, '-c', cwd]);
  }

  async renameSession(current: string, next: string): Promise<void> {
    await run('tmux', ['rename-session', '-t', current, next]);
  }

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
