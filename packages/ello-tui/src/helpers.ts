/**
 * 根据当前文本前缀返回 slash command 候选项。
 */
export function suggestSlashCommands(value: string): string[] {
  const commands = [
    '/help',
    '/model',
    '/resume',
    '/new',
    '/compact',
    '/tools',
    '/config',
    '/memory',
    '/permissions',
    '/tasks',
    '/exit',
  ];
  return commands.filter((command) => command.startsWith(value));
}
