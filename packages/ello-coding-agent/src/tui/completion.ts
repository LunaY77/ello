import { slashCommands } from '../slash-commands.js';

import type { ComposerSuggestion } from './components/Composer.js';

export function completeInput(
  input: string,
  models: readonly string[],
  files: readonly string[],
): readonly ComposerSuggestion[] | undefined {
  const trimmedLeft = input.trimStart();
  if (trimmedLeft.startsWith('/model ')) {
    const query = trimmedLeft.slice('/model '.length).toLowerCase();
    return models
      .filter((item) => item.toLowerCase().includes(query))
      .map((item) => `/model ${item}`);
  }
  if (trimmedLeft.startsWith('/')) {
    const query = trimmedLeft.slice(1).toLowerCase();
    return slashCommands
      .filter(
        (command) =>
          command.name.toLowerCase().startsWith(query) ||
          command.aliases?.some((alias) =>
            alias.toLowerCase().startsWith(query),
          ),
      )
      .map((command) => ({
        value: `/${command.name}`,
        label: `/${command.name}`,
        description: command.description,
      }))
      .slice(0, 5);
  }
  if (trimmedLeft.startsWith('@')) {
    return files;
  }
  return undefined;
}
