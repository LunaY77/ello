import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSkillsFromDir } from '../../src/agent/skills/loader.js';

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
      'code-review',
      [
        '---',
        'name: code-review',
        'description: Review code changes.',
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

  it('跟随目录 symlink 并保留 link/real path', async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'ello-skill-source-'));
    await writeSkillAt(sourceRoot, 'linked');
    await symlink(
      path.join(sourceRoot, 'linked'),
      path.join(dir, 'linked'),
      'dir',
    );
    await expect(loadSkillsFromDir(dir, 'global')).resolves.toMatchObject([
      {
        name: 'linked',
        baseDir: path.join(dir, 'linked'),
        realPath: path.join(sourceRoot, 'linked'),
      },
    ]);
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it('broken symlink 使整个加载失败', async () => {
    await symlink(path.join(dir, 'missing'), path.join(dir, 'broken'), 'dir');
    await expect(loadSkillsFromDir(dir, 'global')).rejects.toThrow(/broken/u);
  });

  async function writeSkill(name: string, content: string): Promise<void> {
    const skillDir = path.join(dir, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), `${content}\n`, 'utf8');
  }

  async function writeSkillAt(root: string, name: string): Promise<void> {
    const skillDir = path.join(root, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Test.\n---\n\nBody.\n`,
      'utf8',
    );
  }
});
