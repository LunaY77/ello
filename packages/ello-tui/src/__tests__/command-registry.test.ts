import { describe, expect, it } from 'vitest';

import { slashCommands } from '../cli/slash-commands.js';
import {
  buildCommands,
  filterCommands,
  findCommandById,
  groupCommands,
} from '../tui/commands/registry.js';

describe('command registry', () => {
  it('covers every slash command with a single source of truth', () => {
    const commands = buildCommands();
    expect(commands).toHaveLength(slashCommands.length);
    for (const slash of slashCommands) {
      expect(commands.some((command) => command.slash === slash.name)).toBe(
        true,
      );
    }
  });

  it('layers UI metadata (id/group/shortcut) onto known commands', () => {
    const theme = findCommandById('theme.switch');
    expect(theme?.slash).toBe('theme');
    expect(theme?.group).toBe('View');
    expect(theme?.shortcut).toBe('ctrl+t');
  });

  it('inherits slash description and merges aliases into keywords', () => {
    const help = findCommandById('help.open');
    expect(help?.description).toBe('Show commands');
    expect(help?.keywords).toContain('?');
  });

  it('filters and ranks by fuzzy score, empty query keeps order', () => {
    const commands = buildCommands();
    expect(filterCommands(commands, '')).toEqual(commands);

    const ranked = filterCommands(commands, 'theme');
    expect(ranked[0]?.id).toBe('theme.switch');
  });

  it('groups commands while preserving first-seen group order', () => {
    const grouped = groupCommands(buildCommands());
    const groups = grouped.map((entry) => entry.group);
    expect(groups[0]).toBe('Session'); // mode is first slash command
    expect(new Set(groups).size).toBe(groups.length);
  });
});
