import type { CodingAgentConfig, CodingAgentController } from '@ello/coding-agent';
import type { Dispatch } from 'react';


import { submitCodingPrompt } from '../interaction.js';
import { errorItem, userItem, type TuiAction } from '../state/index.js';

/**
 * 构建 composer 使用的 prompt 提交处理器。
 */
export function createSubmitHandler(options: {
  config: CodingAgentConfig;
  controller: CodingAgentController;
  dispatch: Dispatch<TuiAction>;
  exit: () => void;
}): (value: string) => Promise<void> {
  return async (value: string) => {
    const trimmed = value.trim();
    options.dispatch({ type: 'composer_set', value: '' });
    if (!trimmed) {
      return;
    }
    options.dispatch({ type: 'append', item: userItem(trimmed) });
    options.dispatch({ type: 'history_push', value: trimmed });
    try {
      await submitCodingPrompt({
        prompt: trimmed,
        config: options.config,
        controller: options.controller,
        dispatch: options.dispatch,
        exit: options.exit,
      });
    } catch (error) {
      options.dispatch({
        type: 'append',
        item: errorItem(error instanceof Error ? error.message : String(error)),
      });
    }
  };
}
