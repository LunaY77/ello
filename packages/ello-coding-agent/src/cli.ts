#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runCli } from './cli/main.js';

export { buildProgram, runCli, type CliIo } from './cli/main.js';

/**
 * coding-agent 可执行入口。
 *
 * 真正的命令树在 `cli/main.ts`（commander）。这里只做两件事：当本文件是进程入口时
 * 启动 CLI，并把 EPIPE（下游管道提前关闭，如 `| head`）这种良性错误吞掉。
 */
if (isCliEntrypoint()) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') {
    process.exitCode = 0;
    return;
  }
  throw error;
});

/** 判断本模块是否作为 CLI 直接执行（而非被 import）。 */
function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))
  );
}
