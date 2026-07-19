import { describe, expect, it } from 'vitest';

import type { AgentSkill } from '../../src/api/protocol-types.js';
import { completeInput } from '../../src/tui/completion.js';

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: 'workspace',
    name: 'workspace',
    description: 'Manage workspaces.',
    enabled: true,
    metadata: { source: 'project' },
    ...overrides,
  };
}

describe('输入补全', () => {
  it('输入单个斜杠时列出带说明的用户命令', () => {
    const suggestions = completeInput('/', [], []);

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: '/help',
          description: 'Show commands',
        }),
        expect.objectContaining({
          value: '/models',
          description: 'Browse model catalog',
        }),
        expect.objectContaining({
          value: '/settings',
          description: 'Open settings',
        }),
        expect.objectContaining({ value: '/quit', description: 'Quit TUI' }),
      ]),
    );
    expect(suggestions?.length).toBeGreaterThan(5);
  });

  it('按命令前缀过滤结果且不任意截断', () => {
    expect(completeInput('/mo', [], [])).toEqual([
      {
        value: '/mode',
        label: '/mode',
        description: 'Show or change the thread mode',
      },
      {
        value: '/models',
        label: '/models',
        description: 'Browse model catalog',
      },
    ]);
  });

  it('为 profile 参数补全可选名称', () => {
    expect(completeInput('/profiles ma', ['main', 'anthropic'], [])).toEqual([
      '/profiles main',
    ]);
  });

  it('按名称或说明匹配技能，并保持技能来源可见', () => {
    const suggestions = completeInput(
      '$work',
      [],
      [],
      [skill({ description: 'Manage repositories and working trees.' })],
    );

    expect(suggestions).toEqual([
      expect.objectContaining({
        value: '$workspace',
        label: '$workspace',
        description: 'project · Manage repositories and working trees.',
        replaceFrom: 0,
        replaceTo: 5,
        appendSpace: true,
      }),
    ]);
  });

  it('把多行过长的技能说明压成单行并裁剪', () => {
    const suggestions = completeInput(
      '$work',
      [],
      [],
      [
        skill({
          description:
            'Manage Ello workspaces and repositories.\nCreate detached references and inspect repository state.',
          metadata: { source: 'global' },
        }),
      ],
    );
    const first = suggestions?.[0];

    expect(first).not.toBeTypeOf('string');
    expect(typeof first === 'string' ? first : first?.description).toMatch(
      /^global · [^\n]+\.\.\.$/u,
    );
  });

  it('光标位于词元中间时只替换当前技能词元', () => {
    expect(
      completeInput('please $work-old keep', [], [], [skill()], {
        line: 0,
        column: 12,
      }),
    ).toEqual([
      expect.objectContaining({
        replaceFrom: 7,
        replaceTo: 16,
        value: '$workspace',
      }),
    ]);
  });

  it('普通输入仅返回调用方提供的文件候选，无候选时不弹出列表', () => {
    expect(completeInput('see @src', [], ['src/a.ts'])).toEqual(['src/a.ts']);
    expect(completeInput('plain text', [], [])).toBeUndefined();
  });
});
