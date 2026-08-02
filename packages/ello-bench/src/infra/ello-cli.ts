import type { ProcessResult } from '../domain/contract/index.js';
import type { ContainerHandle } from '../ports/container.js';

import { CONTAINER_ELLO_RUNTIME_ROOT } from './agent/container-paths.js';

export async function runElloCli(options: {
  readonly container: ContainerHandle;
  readonly endpoint: string;
  readonly workspace: '/app';
  readonly elloHome: string;
  readonly instruction: string;
  readonly threadId?: string;
  readonly timeoutMs: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<ProcessResult> {
  const execution = await options.container.exec(
    [
      `${CONTAINER_ELLO_RUNTIME_ROOT}/node`,
      `${CONTAINER_ELLO_RUNTIME_ROOT}/packages/ello-tui/dist/cli/main.js`,
      '--remote',
      options.endpoint,
      '--json',
      '--no-tui',
      '--root',
      options.workspace,
      'run',
      '--mode',
      'bypass',
      ...(options.threadId === undefined ? [] : ['--thread', options.threadId]),
      options.instruction,
    ],
    {
      cwd: options.workspace,
      env: { ...options.env, ELLO_HOME: options.elloHome },
      timeoutMs: options.timeoutMs,
      killGraceMs: 10_000,
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
    },
  );
  return execution.process;
}
