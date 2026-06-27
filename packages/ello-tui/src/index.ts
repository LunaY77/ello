import type { CodingAgentConfig } from '@ello/coding-agent';
import { CodingAgentController, createCodingAgentSession } from '@ello/coding-agent';
import { render } from 'ink';
import React from 'react';

import { CodingAgentApp } from './App.js';

export interface RenderCodingAgentTuiOptions {
  config: CodingAgentConfig;
}

/**
 * 为已配置的 coding-agent 会话渲染 Ink UI。
 */
export async function renderCodingAgentTui(
  options: RenderCodingAgentTuiOptions,
): Promise<void> {
  const session = await createCodingAgentSession(options.config);
  const controller = new CodingAgentController(session);
  const app = render(
    React.createElement(CodingAgentApp, {
      controller,
      config: options.config,
    }),
  );
  await app.waitUntilExit();
  await controller.close();
}

export { CodingAgentApp } from './App.js';
export { Composer } from './Composer.js';
export {
  createInitialState,
  errorItem,
  systemItem,
  tuiReducer,
  type OverlayKind,
  type TuiAction,
  type TuiState,
  type TranscriptItem,
  userItem,
} from './state/index.js';
export { suggestSlashCommands } from './helpers.js';
export {
  applyFileSuggestion,
  findActiveFileReference,
  suggestFileReferences,
  type FileSuggestion,
} from './file-autocomplete.js';
export { handleCodingAgentKey, type KeybindingOptions } from './keyboard.js';
export { useCodingAgentKeybindings } from './input.js';
export { submitCodingPrompt, executeSlashCommand } from './interaction.js';
