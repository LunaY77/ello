import { render } from 'ink';
import { createElement } from 'react';

import type { CodingAgentConfig } from '../config.js';
import { CodingAgentRuntime } from '../product/runtime.js';

import { CodingAgentApp } from './App.js';

export interface RenderCodingAgentTuiOptions {
  readonly config: CodingAgentConfig;
}

/** 启动 React Ink TUI。 */
export async function renderCodingAgentTui(options: RenderCodingAgentTuiOptions): Promise<void> {
  const runtime = await CodingAgentRuntime.create({ config: options.config });
  const instance = render(createElement(CodingAgentApp, { runtime, config: options.config }), { maxFps: 20 });
  await instance.waitUntilExit();
  await runtime.close();
}
