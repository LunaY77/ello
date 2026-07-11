import { describe, expect, it } from 'vitest';

import { goalUsage, parseGoalSlashCommand } from '../goal/controller.js';

describe('goal slash command grammar', () => {
  it('parses management actions and goal creation', () => {
    expect(parseGoalSlashCommand(['status'])).toEqual({ action: 'status' });
    expect(parseGoalSlashCommand(['pause'])).toEqual({ action: 'pause' });
    expect(parseGoalSlashCommand(['resume'])).toEqual({ action: 'resume' });
    expect(parseGoalSlashCommand(['clear'])).toEqual({ action: 'clear' });
    expect(
      parseGoalSlashCommand([
        'finish',
        'the',
        'implementation',
        '--tokens',
        '12000',
      ]),
    ).toEqual({
      action: 'create',
      objective: 'finish the implementation',
      tokens: 12000,
    });
  });

  it('rejects missing objectives and malformed token options', () => {
    expect(() => parseGoalSlashCommand([])).toThrow(goalUsage());
    expect(() => parseGoalSlashCommand(['work', '--tokens', '1.5'])).toThrow(
      'positive integer',
    );
    expect(() =>
      parseGoalSlashCommand(['work', '--tokens', '10', 'extra']),
    ).toThrow(goalUsage());
  });
});
