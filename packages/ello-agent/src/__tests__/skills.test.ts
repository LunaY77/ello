import { describe, expect, it } from 'vitest';

import { createSkillTools, skillIndexContext } from '../core/skills.js';

describe('skills', () => {
  it('skill_invoke 会激活 inline 技能并返回 newMessages', async () => {
    const active = new Set<string>();
    const tools = createSkillTools({
      active,
      skills: [
        {
          name: 'verify',
          description: 'Verify changes.',
          instructions: '运行验证命令。',
          context: 'inline',
        },
      ],
    });
    const invoke = tools.find((tool) => tool.name === 'skill_invoke');

    const output = await invoke?.execute(
      { name: 'verify', args: 'build' },
      { runId: 'run', environment: {}, metadata: {} },
    );

    expect(active.has('verify')).toBe(true);
    expect(output).toMatchObject({
      invoked: 'verify',
      context: 'inline',
    });
  });

  it('技能索引按预算输出摘要', () => {
    const section = skillIndexContext({
      contextWindow: 100,
      skills: [
        {
          name: 'one',
          description: 'A very long description '.repeat(20),
          instructions: '正文',
        },
      ],
    });

    expect(section()).toContain('<skills-context>');
  });
});
