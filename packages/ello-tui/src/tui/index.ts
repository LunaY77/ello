import { render } from 'ink';
import React from 'react';

import { ThreadClient } from '../client/thread-client.js';

import { App } from './App.js';

export { App } from './App.js';

export async function renderTui(thread: ThreadClient): Promise<void> {
  const instance = render(React.createElement(App, { thread }));
  await instance.waitUntilExit();
}
