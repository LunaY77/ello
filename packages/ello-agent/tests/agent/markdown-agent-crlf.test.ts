/**
 * 本文件验证 Markdown agent frontmatter 在 CRLF 行尾下的类型完整性。
 *
 * Windows 检出（git autocrlf）会把 `.md` 转成 CRLF；frontmatter 切片若把末行
 * 残留的 `\r` 带进 YAML 文本，数值与布尔字段会被解析为带 `\r` 的字符串，
 * 导致 `AgentMaxTurnsSchema` 等联合校验在 turn/start 全链路上失败。
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

describe('markdown agent frontmatter CRLF 行尾', () => {
  it('CRLF 行尾的 max-turns 解析为 number -1，而非带 \\r 的字符串', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ello-crlf-'));
    roots.push(cwd);
    const agentsDir = path.join(cwd, '.ello', 'agents');
    await mkdir(agentsDir, { recursive: true });
    const raw = [
      '---',
      'description: crlf agent',
      'model: primary_model',
      'max-turns: -1',
      '---',
      '',
      'prompt body',
      '',
    ].join('\r\n');
    await writeFile(path.join(agentsDir, 'crlf-agent.md'), raw, 'utf8');

    const definitions = await loadMarkdownAgents(cwd);
    const agent = definitions.find(
      (definition) => definition.name === 'crlf-agent',
    );
    expect(agent).toBeDefined();
    expect(agent?.maxTurns).toBe(-1);
  });

  it('CRLF 行尾的数值 max-turns 解析为 number', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ello-crlf-'));
    roots.push(cwd);
    const agentsDir = path.join(cwd, '.ello', 'agents');
    await mkdir(agentsDir, { recursive: true });
    const raw = [
      '---',
      'description: crlf agent numeric',
      'model: primary_model',
      'max-turns: 5',
      '---',
      '',
      'prompt body',
      '',
    ].join('\r\n');
    await writeFile(path.join(agentsDir, 'crlf-numeric.md'), raw, 'utf8');

    const definitions = await loadMarkdownAgents(cwd);
    const agent = definitions.find(
      (definition) => definition.name === 'crlf-numeric',
    );
    expect(agent).toBeDefined();
    expect(agent?.maxTurns).toBe(5);
  });
});
