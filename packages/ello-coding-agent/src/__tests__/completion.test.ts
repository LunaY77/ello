import { describe, expect, it } from 'vitest';

import { completeInput } from '../tui/completion.js';

describe('TUI completion', () => {
  it('lists the first five slash commands with descriptions after /', () => {
    const suggestions = completeInput('/', [], []);

    expect(suggestions).toHaveLength(5);
    expect(suggestions).toEqual([
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
        value: '/model',
        label: '/model',
        description: 'Switch or show model',
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
    ]);
  });

  it('filters slash commands before applying the five item limit', () => {
    const suggestions = completeInput('/mo', [], []);

    expect(suggestions).toEqual([
      {
        value: '/model',
        label: '/model',
        description: 'Switch or show model',
      },
    ]);
  });
});
