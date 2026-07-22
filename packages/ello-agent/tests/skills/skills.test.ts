/**
 * 本文件验证 skills 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { describe, expect, it } from 'vitest';

import { skillIndexContext } from '../../src/features/agent/engine/model-input.js';

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
      contextWindow: 160_000,
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
