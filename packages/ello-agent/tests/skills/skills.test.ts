import { describe, expect, it } from 'vitest';

import { skillIndexContext } from '../../src/agent/engine/core/skills.js';

describe('skills', () => {
  it('技能索引按预算输出摘要', () => {
    const section = skillIndexContext({
      contextWindow: 100,
      skills: [
        {
          name: 'one',
          description: 'A very long description '.repeat(20),
          source: 'global',
          baseDir: '/skills/one',
          realPath: '/skills/one',
          skillPath: '/skills/one/SKILL.md',
          contentHash: 'hash',
          instructions: '正文',
        },
      ],
    });

    expect(section({} as never)).toContain('<skills-context>');
    expect(section({} as never)).toContain('Use activate_skill');
  });

  it('把全部技能放入稳定索引', () => {
    const section = skillIndexContext({
      skills: [
        {
          name: 'manual',
          description: 'Manual only.',
          source: 'project',
          baseDir: '/manual',
          realPath: '/manual',
          skillPath: '/manual/SKILL.md',
          contentHash: 'hash',
          instructions: 'manual',
        },
      ],
    });
    expect(section({} as never)).toContain('- manual: Manual only.');
  });
});
