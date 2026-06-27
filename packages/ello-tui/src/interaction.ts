import type { CodingAgentConfig, CodingAgentController, SlashCommandResult } from '@ello/coding-agent';
import { handleSlashCommand } from '@ello/coding-agent';
import type { Dispatch } from 'react';


import type { TuiAction } from './state/index.js';

/**
 * 统一处理提交的 prompt，包括 slash command 和普通 agent 分发，
 * 让 app 组件保持声明式。
 */
export async function submitCodingPrompt(options: {
  prompt: string;
  config: CodingAgentConfig;
  controller: CodingAgentController;
  dispatch: Dispatch<TuiAction>;
  exit: () => void;
}): Promise<void> {
  const slash = handleSlashCommand(options.prompt, options.config);
  if (slash.handled) {
    await executeSlashCommand(slash, options.controller, options.dispatch, options.exit);
    return;
  }
  await options.controller.submitUserMessage(options.prompt);
}

/**
 * 执行已经从 prompt 行解析出的 slash command。
 */
export async function executeSlashCommand(
  slash: SlashCommandResult,
  controller: CodingAgentController,
  dispatch: Dispatch<TuiAction>,
  exit: () => void,
): Promise<void> {
  if (!slash.handled) {
    return;
  }
  if (slash.command === 'exit') {
    exit();
    return;
  }
  if (slash.command === 'model' && slash.args[0]) {
    await controller.switchModel(slash.args[0]);
  } else if (slash.command === 'compact') {
    await controller.compact();
  } else if (slash.command === 'resume' && slash.args[0]) {
    await controller.resumeSession(slash.args[0]);
  }
  dispatch({ type: 'slash', command: slash });
}
