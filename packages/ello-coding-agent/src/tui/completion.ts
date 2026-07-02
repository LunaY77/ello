import { buildCommands } from './commands/registry.js';
import type { ComposerSuggestion } from './component/Composer.js';

export function completeInput(
  input: string,
  models: readonly string[],
  files: readonly string[],
): readonly ComposerSuggestion[] | undefined {
  const trimmedLeft = input.trimStart();
  if (trimmedLeft.startsWith('/profiles ')) {
    const query = trimmedLeft.slice('/profiles '.length).toLowerCase();
    return models
      .filter((item) => item.toLowerCase().includes(query))
      .map((item) => `/profiles ${item}`);
  }
  if (trimmedLeft.startsWith('/')) {
    const query = trimmedLeft.slice(1).toLowerCase();
    return buildCommands()
      .filter(
        (command) =>
          query === '' ||
          command.slash.toLowerCase().startsWith(query) ||
          command.keywords.some((keyword) =>
            keyword.toLowerCase().startsWith(query),
          ),
      )
      .map((command) => ({
        value: `/${command.slash}`,
        label: `/${command.slash}`,
        description: command.description,
      }));
  }
  if (files.length > 0) {
    return files;
  }
  return undefined;
}
