import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AgentContext,
  LocalEnvironment,
  SkillToolset,
  loadSkillsFromDir,
  parseSkillMarkdown,
} from '../index.js';

function dedent(text: string): string {
  const lines = text.replace(/^\n/, '').split('\n');
  const indent = Math.min(
    ...lines
      .filter((line) => line.trim().length > 0)
      .map((line) => line.match(/^ */)?.[0].length ?? 0),
  );
  return lines.map((line) => line.slice(indent)).join('\n');
}

function ctx(): { deps: AgentContext } {
  return {
    deps: new AgentContext({ env: new LocalEnvironment() }),
  };
}

describe('parseSkillMarkdown', () => {
  it('parses valid frontmatter and body', () => {
    const skill = parseSkillMarkdown(
      dedent(`
        ---
        name: code_review
        description: Perform thorough code review
        ---

        Review the code focusing on:
        1. Security vulnerabilities
        2. Performance issues
      `),
    );

    expect(skill.name).toBe('code_review');
    expect(skill.description).toBe('Perform thorough code review');
    expect(skill.body).toContain('Security vulnerabilities');
  });

  it('rejects missing frontmatter', () => {
    expect(() => parseSkillMarkdown('No frontmatter here')).toThrow(
      'frontmatter',
    );
  });

  it('rejects missing name', () => {
    expect(() =>
      parseSkillMarkdown(
        dedent(`
          ---
          description: No name field
          ---

          Body
        `),
      ),
    ).toThrow('name');
  });

  it('allows empty body', () => {
    const skill = parseSkillMarkdown(
      dedent(`
        ---
        name: minimal
        description: Minimal skill
        ---
      `),
    );

    expect(skill.name).toBe('minimal');
    expect(skill.body).toBe('');
  });

  it('unquotes simple YAML scalar values', () => {
    const skill = parseSkillMarkdown(
      dedent(`
        ---
        name: "quoted"
        description: 'Quoted desc'
        ---

        Body
      `),
    );

    expect(skill.name).toBe('quoted');
    expect(skill.description).toBe('Quoted desc');
  });
});

describe('loadSkillsFromDir', () => {
  it('loads valid markdown skills from directory', async ({ task }) => {
    const dir = join('/tmp', `ello-ts-skills-${task.id}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'test.md'),
      dedent(`
        ---
        name: test_skill
        description: A test skill
        ---

        Do the thing.
      `),
      'utf8',
    );

    const skills = await loadSkillsFromDir(dir);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('test_skill');
  });

  it('skips invalid markdown files', async ({ task }) => {
    const dir = join('/tmp', `ello-ts-skills-invalid-${task.id}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'good.md'),
      dedent(`
        ---
        name: good
        description: Works
        ---

        Content
      `),
      'utf8',
    );
    await writeFile(join(dir, 'bad.md'), 'no frontmatter', 'utf8');

    const skills = await loadSkillsFromDir(dir);

    expect(skills.map((skill) => skill.name)).toEqual(['good']);
  });

  it('returns empty list for nonexistent directory', async () => {
    await expect(
      loadSkillsFromDir('/tmp/ello-ts-missing-skills'),
    ).resolves.toEqual([]);
  });
});

describe('SkillToolset', () => {
  it('provides activate_skill tool and instructions', async ({ task }) => {
    const dir = join('/tmp', `ello-ts-skill-toolset-${task.id}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'review.md'),
      dedent(`
        ---
        name: code_review
        description: Review code carefully
        ---

        Check correctness and security.
      `),
      'utf8',
    );

    const toolset = new SkillToolset({ skillsDirs: [dir] });
    const tools = await toolset.getTools(ctx());
    const instructions = await toolset.getInstructions(ctx());

    expect(Object.keys(tools)).toEqual(['activate_skill']);
    expect(instructions).toContain('code_review: Review code carefully');
  });

  it('activates a skill and marks it active in instructions', async ({
    task,
  }) => {
    const dir = join('/tmp', `ello-ts-skill-active-${task.id}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'review.md'),
      dedent(`
        ---
        name: code_review
        description: Review code carefully
        ---

        Check correctness and security.
      `),
      'utf8',
    );

    const toolset = new SkillToolset({ skillsDirs: [dir] });
    const result = await toolset.callTool(
      'activate_skill',
      { skillName: 'code_review' },
      ctx(),
    );

    expect(result).toContain("Skill 'code_review' activated.");
    expect(result).toContain('Check correctness');
    await expect(toolset.getInstructions(ctx())).resolves.toContain(
      'code_review: Review code carefully [active]',
    );
  });

  it('returns available skills when activation target is missing', async ({
    task,
  }) => {
    const dir = join('/tmp', `ello-ts-skill-missing-${task.id}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'review.md'),
      dedent(`
        ---
        name: code_review
        description: Review code carefully
        ---

        Body
      `),
      'utf8',
    );

    const toolset = new SkillToolset({ skillsDirs: [dir] });
    const result = await toolset.callTool(
      'activate_skill',
      { skillName: 'missing' },
      ctx(),
    );

    expect(result).toBe("Skill 'missing' not found. Available: code_review");
  });

  it('returns no tools when no skills exist', async () => {
    const toolset = new SkillToolset({
      skillsDirs: ['/tmp/ello-ts-missing-skills-toolset'],
    });

    await expect(toolset.getTools(ctx())).resolves.toEqual({});
    await expect(toolset.getInstructions(ctx())).resolves.toBeNull();
  });
});
