import { PassThrough } from 'node:stream';

import { render } from 'ink';
import type { ReactElement } from 'react';

import { AnsiScreen } from './ansi-screen.js';

export interface TerminalHarness {
  readonly screen: AnsiScreen;
  /** 每帧写入的字节，用来判断是否发生整屏重绘。 */
  readonly writes: string[];
  /** 假 stdin，可写入按键序列。 */
  readonly stdin: PassThrough;
  rerender(view: ReactElement): Promise<void>;
  /** 等 Ink 把挂起的帧刷到 stdout。 */
  flush(): Promise<void>;
  stop(): void;
}

/**
 * 把 Ink 渲染到带 rows/columns 的假 TTY 上，并用 AnsiScreen 还原可见画面。
 * 断言"屏幕上有什么"比断言"输出流里有什么"更能反映真实体验。
 */
export async function mountTerminal(
  view: ReactElement,
  options: { readonly columns: number; readonly rows: number },
): Promise<TerminalHarness> {
  const stdout = new PassThrough();
  Object.assign(stdout, {
    columns: options.columns,
    isTTY: true,
    rows: options.rows,
  });
  // App 用 useInput，Ink 会要求 stdin 支持 raw mode。
  const stdin = new PassThrough();
  Object.assign(stdin, {
    isTTY: true,
    ref: () => undefined,
    setEncoding: () => undefined,
    setRawMode: () => undefined,
    unref: () => undefined,
  });
  const screen = new AnsiScreen(options);
  const writes: string[] = [];
  stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    writes.push(text);
    screen.write(text);
  });
  const instance = render(view, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    maxFps: 1_000_000,
  });
  await flush();
  return {
    screen,
    writes,
    stdin,
    async rerender(next) {
      instance.rerender(next);
      await flush();
    },
    flush,
    stop() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
}
