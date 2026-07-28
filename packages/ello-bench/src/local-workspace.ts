import path from 'node:path';

import { ensureEmptyDirectory } from './filesystem.js';
import { configureGitWorkspace } from './git-workspace.js';
import { runChecked } from './process.js';

const GIT_OPTIONS = {
  timeoutMs: 30 * 60_000,
  killGraceMs: 5_000,
  maxOutputBytes: 256 * 1024 * 1024,
} as const;

/** Clone a task repository and detach it at the task's pinned base commit. */
export async function cloneLocalWorkspace(options: {
  readonly repository: string;
  readonly revision: string;
  readonly workspace: string;
}): Promise<void> {
  const workspace = path.resolve(options.workspace);
  await ensureEmptyDirectory(workspace);
  await runChecked(
    'git',
    [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      options.repository,
      workspace,
    ],
    { cwd: path.dirname(workspace), ...GIT_OPTIONS },
  );
  await runChecked(
    'git',
    ['-C', workspace, 'checkout', '--detach', options.revision],
    { cwd: workspace, ...GIT_OPTIONS },
  );
  await configureGitWorkspace(workspace);
}
