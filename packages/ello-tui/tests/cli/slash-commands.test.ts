import { describe, expect, it } from 'vitest';

import {
  handleSlashCommand,
  slashCommands,
} from '../../src/cli/slash-commands.js';

describe('斜杠命令派发', () => {
  it('普通用户文本不被当成命令处理', () => {
    expect(handleSlashCommand('explain /models')).toEqual({
      handled: false,
      output: '',
    });
  });

  it('把浏览命令映射到对应用户界面', () => {
    expect(handleSlashCommand('/models').command).toEqual({
      type: 'open-overlay',
      overlay: 'models',
    });
    expect(handleSlashCommand('/agents').command).toEqual({
      type: 'open-overlay',
      overlay: 'agents',
    });
    expect(handleSlashCommand('/settings').command).toEqual({
      type: 'open-overlay',
      overlay: 'settings',
    });
  });

  it('有参数时直接切换 profile，无参数时打开选择界面', () => {
    expect(handleSlashCommand('/profiles main').command).toEqual({
      type: 'set-profile',
      profile: 'main',
    });
    expect(handleSlashCommand('/profiles').command).toEqual({
      type: 'open-overlay',
      overlay: 'profiles',
    });
  });

  it('校验会话模式，并为无效值返回明确用法', () => {
    expect(handleSlashCommand('/mode plan').command).toEqual({
      type: 'set-mode',
      mode: 'plan',
    });
    expect(handleSlashCommand('/mode unsupported').command).toEqual({
      type: 'message',
      message: 'Usage: /mode <ask-before-changes|accept-edits|plan|bypass>',
    });
  });

  it('/plan 无参数进入计划模式，有参数时把原文作为提示词提交', () => {
    expect(handleSlashCommand('/plan').command).toEqual({
      type: 'set-mode',
      mode: 'plan',
    });
    expect(handleSlashCommand('/plan inspect then design').command).toEqual({
      type: 'submit',
      prompt: 'inspect then design',
    });
  });

  it('按空白拆分运行时动作参数', () => {
    expect(
      handleSlashCommand('/goal finish implementation --tokens 12000').command,
    ).toEqual({
      type: 'runtime-action',
      action: 'goal',
      args: ['finish', 'implementation', '--tokens', '12000'],
    });
  });

  it('支持公开别名，并明确报告未知或已移除的命令', () => {
    expect(handleSlashCommand('/?').command).toEqual({
      type: 'open-overlay',
      overlay: 'help',
    });
    expect(handleSlashCommand('/exit').command).toEqual({
      type: 'runtime-action',
      action: 'quit',
    });
    expect(handleSlashCommand('/model')).toMatchObject({
      handled: true,
      output: 'Unknown command: /model',
    });
    for (const command of ['/new', '/permissions', '/theme', '/tools']) {
      expect(handleSlashCommand(command)).toMatchObject({
        handled: true,
        output: `Unknown command: ${command}`,
      });
    }
  });

  it('命令注册项名称保持唯一，避免补全与派发歧义', () => {
    const names = slashCommands.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
