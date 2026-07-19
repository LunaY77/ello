import { describe, expect, it } from 'vitest';

import { slashCommands } from '../../src/cli/slash-commands.js';
import {
  buildCommands,
  filterCommands,
  findCommandById,
  groupCommands,
} from '../../src/tui/commands/registry.js';

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
    const settings = findCommandById('config.open');
    expect(settings?.slash).toBe('settings');
    expect(settings?.group).toBe('General');
  });

  it('inherits slash description and merges aliases into keywords', () => {
    const help = findCommandById('help.open');
    expect(help?.description).toBe('Show commands');
    expect(help?.keywords).toContain('?');
  });

  it('filters and ranks by fuzzy score, empty query keeps order', () => {
    const commands = buildCommands();
    expect(filterCommands(commands, '')).toEqual(commands);

    const ranked = filterCommands(commands, 'preferences');
    expect(ranked[0]?.id).toBe('config.open');
  });

  it('groups commands while preserving first-seen group order', () => {
    const grouped = groupCommands(buildCommands());
    const groups = grouped.map((entry) => entry.group);
    expect(groups[0]).toBe('Session'); // mode is first slash command
    expect(new Set(groups).size).toBe(groups.length);
  });
});
