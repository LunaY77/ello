import { useInput } from 'ink';

import { handleCodingAgentKey, type KeybindingOptions } from './keyboard.js';

/**
 * 绑定会话控制、审批和浮层切换相关的键盘快捷键。
 */
export function useCodingAgentKeybindings(options: KeybindingOptions): void {
  useInput((value, key) => {
    handleCodingAgentKey(options, value, key);
  });
}
