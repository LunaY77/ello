import { describe, expect, it } from 'vitest';

import { completeInput } from '../tui/completion.js';

describe('TUI completion', () => {
  it('lists all slash commands with descriptions after /', () => {
    const suggestions = completeInput('/', [], []);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        {
          value: '/help',
          label: '/help',
          description: 'Show commands',
        },
        {
          value: '/clear',
          label: '/clear',
          description: 'Clear context and reset the TUI',
        },
        {
          value: '/models',
          label: '/models',
          description: 'Browse model catalog',
        },
        {
          value: '/profiles',
          label: '/profiles',
          description: 'Switch model profile suite',
        },
        {
          value: '/settings',
          label: '/settings',
          description: 'Open settings',
        },
        {
          value: '/resume',
          label: '/resume',
          description: 'Open session selector',
        },
        {
          value: '/quit',
          label: '/quit',
          description: 'Quit TUI',
        },
      ]),
    );
    expect(suggestions?.length).toBeGreaterThan(5);
  });

  it('filters slash commands without truncating the result set', () => {
    const suggestions = completeInput('/mo', [], []);

    expect(suggestions).toEqual([
      {
        value: '/models',
        label: '/models',
        description: 'Browse model catalog',
      },
    ]);
  });

  it('completes profile suite names for /profiles', () => {
    const suggestions = completeInput(
      '/profiles ma',
      ['main', 'anthropic'],
      [],
    );

    expect(suggestions).toEqual(['/profiles main']);
  });
});
