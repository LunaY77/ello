/**
 * 终端屏幕副作用的唯一出口。
 *
 * `TerminalHistoryOutput` 用 `resetKey` 重挂 Ink `Static`，重挂会把全部历史条目
 * 重新写一遍。若不先清屏 + 清 scrollback，终端里就会留下两份历史。设计稿
 * `docs/tui/ello-tui-design.md` §11 / §15 要求 active path 变化时重置 scrollback。
 */
export function clearTerminalScrollback(): void {
  if (process.stdout.isTTY !== true) return;
  // 2J 清屏、3J 清 scrollback、H 归位光标。
  process.stdout.write('\u001B[2J\u001B[3J\u001B[H');
}
