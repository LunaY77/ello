import { run } from './git.js';

/** 可选 tmux 集成：没有 tmux 时让调用方看到清晰错误。 */
export class TmuxStore {
  async newSession(
    session: string,
    cwd: string,
  ): Promise<{ session: string; cwd: string }> {
    await run('tmux', ['new-session', '-d', '-s', session, '-c', cwd]);
    return { session, cwd };
  }

  async list(): Promise<readonly string[]> {
    const output = await run('tmux', ['list-sessions', '-F', '#S']);
    return output === '' ? [] : output.split(/\r?\n/u);
  }
}
