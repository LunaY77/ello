#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: validate_skill.mjs <skill-dir>');
  process.exit(2);
}

const skillPath = path.join(dir, 'SKILL.md');
try {
  const info = await stat(skillPath);
  if (!info.isFile()) {
    throw new Error('SKILL.md is not a file');
  }
  const text = await readFile(skillPath, 'utf8');
  if (!text.startsWith('---\n')) {
    throw new Error('SKILL.md must start with YAML frontmatter');
  }
  const end = text.indexOf('\n---', 4);
  if (end === -1) {
    throw new Error('SKILL.md frontmatter is not closed');
  }
  const frontmatter = text.slice(4, end);
  for (const key of ['name:', 'description:']) {
    if (!frontmatter.includes(key)) {
      throw new Error(`missing required frontmatter key: ${key}`);
    }
  }
  console.log(`ok\t${skillPath}`);
} catch (error) {
  console.error(`invalid\t${skillPath}\t${error.message}`);
  process.exit(1);
}
