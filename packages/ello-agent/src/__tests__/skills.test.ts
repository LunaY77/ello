import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSkillTools,
  loadSkillsFromDir,
  skillIndexContext,
} from '../core/skills.js';

describe('skills', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ello-skills-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('解析 SKILL.md frontmatter', async () => {
    await writeSkill(
      'review',
      [
        '---',
        'name: code-review',
        'description: Review code changes.',
        'when_to_use: User asks for review.',
        'allowed-tools:',
        '  - read',
        '  - grep',
        'context: fork',
        '---',
        '',
        '# Code Review',
        '审查代码风险。',
      ].join('\n'),
    );

    const skills = await loadSkillsFromDir(dir, 'project');

    expect(skills[0]).toMatchObject({
      name: 'code-review',
      description: 'Review code changes.',
      whenToUse: 'User asks for review.',
      allowedTools: ['read', 'grep'],
      context: 'fork',
      source: 'project',
    });
  });

  it('缺少 description 时抛出清晰错误', async () => {
    await writeSkill(
      'broken',
      ['---', 'name: broken', '---', '正文'].join('\n'),
    );

    await expect(loadSkillsFromDir(dir)).rejects.toThrow(
      'Skill broken is missing description.',
    );
  });

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

  async function writeSkill(name: string, content: string): Promise<void> {
    const skillDir = path.join(dir, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), `${content}\n`, 'utf8');
  }
});
