/**
 * 本文件验证 Markdown agent 正文的模板渲染与角色能力隔离。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadMarkdownAgents } from '../../src/features/agent/subagents/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('agent prompt rendering', () => {
  it('只给 worker definition 注入写入与验证规则', async () => {
    const cwd = await temporaryRoot();
    const definitions = await loadMarkdownAgents(cwd);
    const worker = definitions.find(
      (definition) => definition.name === 'worker',
    );
    const explore = definitions.find(
      (definition) => definition.name === 'explore',
    );

    expect(worker?.prompt).toContain('# Verification');
    expect(worker?.prompt).toContain('apply_patch');
    expect(explore?.prompt).not.toContain('# Verification');
    expect(explore?.prompt).not.toContain('apply_patch');
  });

  it('正文 include 越过 prompts 根目录时带文件路径失败', async () => {
    const cwd = await temporaryRoot();
    const agentsDir = path.join(cwd, '.ello', 'agents');
    const definitionPath = path.join(agentsDir, 'unsafe.md');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      definitionPath,
      `---
description: unsafe include
mode: subagent
model: auxiliary_model
max-turns: 1
---

{% include "../../../etc/passwd" %}
`,
      'utf8',
    );

    await expect(loadMarkdownAgents(cwd)).rejects.toThrow(definitionPath);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-agent-prompt-'));
  roots.push(root);
  return root;
}
