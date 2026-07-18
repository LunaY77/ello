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
          value: '/agents',
          label: '/agents',
          description: 'Browse delegatable subagents',
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
        value: '/mode',
        label: '/mode',
        description: 'Show or change the session mode',
      },
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

  it('completes available skills without mixing slash commands', () => {
    const suggestions = completeInput(
      '$ski',
      [],
      [],
      [
        {
          name: 'skill-creator',
          description: 'Create skills.',
          source: 'global',
          baseDir: '/skills/skill-creator',
          realPath: '/skills/skill-creator',
          skillPath: '/skills/skill-creator/SKILL.md',
          contentHash: 'hash',
          instructions: 'Create.',
        },
      ],
    );
    expect(suggestions).toEqual([
      expect.objectContaining({
        value: '$skill-creator',
        replaceFrom: 0,
        replaceTo: 4,
        appendSpace: true,
      }),
    ]);
  });

  it('keeps skill descriptions on one clipped line', () => {
    const suggestions = completeInput(
      '$work',
      [],
      [],
      [
        {
          name: 'workspace',
          description:
            'Manage Ello workspaces and repositories.\nCreate detached references and inspect repository state.',
          source: 'global',
          baseDir: '/skills/workspace',
          realPath: '/skills/workspace',
          skillPath: '/skills/workspace/SKILL.md',
          contentHash: 'hash',
          instructions: 'Manage.',
        },
      ],
    );

    const description = suggestions?.[0];
    expect(description).not.toBeTypeOf('string');
    expect(
      typeof description === 'string' ? description : description?.description,
    ).toMatch(/^global · [^\n]+\.\.\.$/u);
  });

  it('replaces only the skill token when the cursor is in the middle', () => {
    const skill = {
      name: 'workspace',
      description: 'Manage workspaces.',
      source: 'project' as const,
      baseDir: '/skills/workspace',
      realPath: '/skills/workspace',
      skillPath: '/skills/workspace/SKILL.md',
      contentHash: 'hash',
      instructions: 'Manage.',
    };
    expect(
      completeInput('please $work-old keep', [], [], [skill], {
        line: 0,
        column: 12,
      }),
    ).toEqual([
      expect.objectContaining({
        replaceFrom: 7,
        replaceTo: 16,
        value: '$workspace',
      }),
    ]);
  });
});
