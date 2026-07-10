import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSkillsFromDir } from '../skills/loader.js';

describe('skill loader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ello-skills-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('解析并校验 SKILL.md frontmatter', async () => {
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

    await expect(loadSkillsFromDir(dir, 'project')).resolves.toMatchObject([
      {
        name: 'code-review',
        description: 'Review code changes.',
        whenToUse: 'User asks for review.',
        allowedTools: ['read', 'grep'],
        context: 'fork',
        source: 'project',
      },
    ]);
  });

  it('缺少 description 时直接拒绝', async () => {
    await writeSkill(
      'broken',
      ['---', 'name: broken', '---', '正文'].join('\n'),
    );

    await expect(loadSkillsFromDir(dir, 'project')).rejects.toThrow();
  });

  async function writeSkill(name: string, content: string): Promise<void> {
    const skillDir = path.join(dir, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), `${content}\n`, 'utf8');
  }
});
