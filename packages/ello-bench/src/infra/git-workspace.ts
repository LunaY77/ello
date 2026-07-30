import { runChecked } from './process.js';

const GIT_OPTIONS = {
  timeoutMs: 10 * 60_000,
  killGraceMs: 5_000,
  maxOutputBytes: 128 * 1024 * 1024,
} as const;

export async function configureGitWorkspace(workspace: string): Promise<void> {
  for (const [key, value] of [
    ['core.filemode', 'false'],
    ['core.autocrlf', 'false'],
    ['core.safecrlf', 'false'],
  ] as const) {
    await runChecked('git', ['-C', workspace, 'config', key, value], {
      cwd: workspace,
      ...GIT_OPTIONS,
    });
  }
}

export async function assertGitHead(
  workspace: string,
  revision: string,
  subject: string,
): Promise<void> {
  const [expected, actual] = await Promise.all([
    runChecked('git', ['-C', workspace, 'rev-parse', `${revision}^{commit}`], {
      cwd: workspace,
      ...GIT_OPTIONS,
    }),
    runChecked('git', ['-C', workspace, 'rev-parse', 'HEAD'], {
      cwd: workspace,
      ...GIT_OPTIONS,
    }),
  ]);
  const expectedCommit = expected.stdout.trim();
  const actualCommit = actual.stdout.trim();
  if (actualCommit !== expectedCommit) {
    throw new Error(
      `${subject} HEAD mismatch: ${actualCommit} versus ${expectedCommit}.`,
    );
  }
}

export async function captureBaselineTree(workspace: string): Promise<string> {
  await runChecked('git', ['-C', workspace, 'add', '-A'], {
    cwd: workspace,
    ...GIT_OPTIONS,
  });
  try {
    const tree = (
      await runChecked('git', ['-C', workspace, 'write-tree'], {
        cwd: workspace,
        ...GIT_OPTIONS,
      })
    ).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/iu.test(tree)) {
      throw new Error(`Invalid baseline tree: ${tree}`);
    }
    return tree;
  } finally {
    await runChecked(
      'git',
      ['-C', workspace, 'reset', '--mixed', '-q', 'HEAD'],
      {
        cwd: workspace,
        ...GIT_OPTIONS,
      },
    );
  }
}
