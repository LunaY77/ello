import { ThemeProvider } from '@inkjs/ui';
import { render } from 'ink';
import { createElement } from 'react';

import type { CodingAgentConfig } from '../config.js';
import { createCodingSession } from '../runtime/coding-session.js';

import { CodingAgentApp } from './App.js';
import { elloTheme } from './theme.js';

export interface LaunchTuiOptions {
  readonly config: CodingAgentConfig;
}

/**
 * 启动交互式 TUI。
 *
 * TUI 是 {@link createCodingSession} 的前端：创建共享会话 → 用 `ThemeProvider`
 * 包裹根组件渲染 → 等待退出 → 关闭会话。若 config 指定了 sessionId，则先恢复。
 */
export async function launchTui(options: LaunchTuiOptions): Promise<void> {
  const session = await createCodingSession({ config: options.config });
  if (options.config.sessionId !== null) {
    await session.resumeSession(options.config.sessionId);
  }
  const instance = render(
    createElement(ThemeProvider, {
      theme: elloTheme,
      children: createElement(CodingAgentApp, {
        session,
        config: options.config,
      }),
    }),
    { maxFps: 30 },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    await session.close();
  }
}
