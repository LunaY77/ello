import { render } from 'ink';
import React from 'react';

import { ThreadClient } from '../client/thread-client.js';

import { App } from './App.js';

export { App } from './App.js';

export async function renderTui(thread: ThreadClient): Promise<void> {
  const instance = render(React.createElement(App, { thread }), {
    exitOnCtrlC: false,
    kittyKeyboard: { mode: 'auto' },
    // 不要开 Ink 的 incrementalRendering：它的 previousLines 记账和 `Static` 输出
    // 互相打断，每帧都会把整个 dock 再画一遍（实测 24 行终端上 composer 会重复 18
    // 次）。闪屏要靠让 dynamic frame 矮于终端高度来解决，见 store/live-budget.ts。
  });
  await instance.waitUntilExit();
}
