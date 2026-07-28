import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ProcessResult } from './contracts.js';
import { runProcess } from './process.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

export async function runElloCli(options: {
  readonly endpoint: string;
  readonly workspace: string;
  readonly elloHome: string;
  readonly instruction: string;
  readonly threadId?: string;
  readonly timeoutMs: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}): Promise<ProcessResult> {
  const cliPath = path.join(
    repositoryRoot,
    'packages',
    'ello-tui',
    'dist',
    'cli',
    'main.js',
  );
  await access(cliPath);
  const execution = await runProcess(
    process.execPath,
    [
      cliPath,
      '--remote',
      options.endpoint,
      '--json',
      '--no-tui',
      'run',
      '--mode',
      'bypass',
      ...(options.threadId === undefined ? [] : ['--thread', options.threadId]),
      options.instruction,
    ],
    {
      cwd: options.workspace,
      env: { ...process.env, ELLO_HOME: options.elloHome },
      timeoutMs: options.timeoutMs,
      killGraceMs: 10_000,
      capture: false,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
    },
  );
  return execution.result;
}
