import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { ensureEmptyDirectory } from './filesystem.js';
import { configureGitWorkspace } from './git-workspace.js';
import { sha256 } from './hash.js';
import { runChecked, runProcess } from './process.js';

const GIT_OPTIONS = {
  timeoutMs: 30 * 60_000,
  killGraceMs: 5_000,
  maxOutputBytes: 256 * 1024 * 1024,
} as const;

const mirrorInitializations = new Map<string, Promise<string>>();

/**
 * 从 suite 级 bare mirror 创建本地 workspace，并检出固定 revision。
 *
 * Args:
 * - `options`: 远端仓库、固定 revision、attempt workspace 和共享缓存根目录。
 *
 * Returns:
 * - workspace 完成离线可复用的本地 clone、detached checkout 与 Git 配置后兑现。
 */
export async function cloneLocalWorkspace(options: {
  readonly repository: string;
  readonly revision: string;
  readonly workspace: string;
  readonly cacheRoot: string;
}): Promise<void> {
  const workspace = path.resolve(options.workspace);
  const mirror = await ensureGitMirror({
    repository: options.repository,
    revision: options.revision,
    cacheRoot: options.cacheRoot,
  });
  await ensureEmptyDirectory(workspace);
  await runChecked('git', ['clone', '--no-checkout', mirror, workspace], {
    cwd: path.dirname(workspace),
    ...GIT_OPTIONS,
  });
  await runChecked(
    'git',
    ['-C', workspace, 'remote', 'set-url', 'origin', options.repository],
    { cwd: workspace, ...GIT_OPTIONS },
  );
  await runChecked(
    'git',
    ['-C', workspace, 'checkout', '--detach', options.revision],
    { cwd: workspace, ...GIT_OPTIONS },
  );
  await configureGitWorkspace(workspace);
}

async function ensureGitMirror(options: {
  readonly repository: string;
  readonly revision: string;
  readonly cacheRoot: string;
}): Promise<string> {
  const cacheRoot = path.resolve(options.cacheRoot);
  const mirrorPath = path.join(cacheRoot, `${sha256(options.repository)}.git`);
  const previousInitialization = mirrorInitializations.get(mirrorPath);
  const initialization = (async () => {
    if (previousInitialization !== undefined) {
      try {
        await previousInitialization;
      } catch {
        // A queued caller must still get a chance to repair or recreate the mirror.
      }
    }
    return initializeGitMirror({
      ...options,
      cacheRoot,
      mirrorPath,
    });
  })();
  mirrorInitializations.set(mirrorPath, initialization);
  try {
    return await initialization;
  } finally {
    if (mirrorInitializations.get(mirrorPath) === initialization) {
      mirrorInitializations.delete(mirrorPath);
    }
  }
}

async function initializeGitMirror(options: {
  readonly repository: string;
  readonly revision: string;
  readonly cacheRoot: string;
  readonly mirrorPath: string;
}): Promise<string> {
  await mkdir(options.cacheRoot, { recursive: true });
  if (!(await pathExists(options.mirrorPath))) {
    await createGitMirror(options);
  }
  const [bare, remote] = await Promise.all([
    runChecked(
      'git',
      ['-C', options.mirrorPath, 'rev-parse', '--is-bare-repository'],
      { cwd: options.cacheRoot, ...GIT_OPTIONS },
    ),
    runChecked(
      'git',
      ['-C', options.mirrorPath, 'remote', 'get-url', 'origin'],
      { cwd: options.cacheRoot, ...GIT_OPTIONS },
    ),
  ]);
  if (bare.stdout.trim() !== 'true') {
    throw new Error(`Git mirror cache is not bare: ${options.mirrorPath}`);
  }
  if (remote.stdout.trim() !== options.repository) {
    throw new Error(
      `Git mirror remote mismatch for ${options.mirrorPath}: ${remote.stdout.trim()} versus ${options.repository}`,
    );
  }
  if (!(await mirrorHasRevision(options.mirrorPath, options.revision))) {
    await runChecked(
      'git',
      [
        '-C',
        options.mirrorPath,
        'fetch',
        '--no-tags',
        'origin',
        options.revision,
      ],
      { cwd: options.cacheRoot, ...GIT_OPTIONS },
    );
  }
  if (!(await mirrorHasRevision(options.mirrorPath, options.revision))) {
    throw new Error(
      `Git mirror does not contain revision ${options.revision}: ${options.mirrorPath}`,
    );
  }
  return options.mirrorPath;
}

async function createGitMirror(options: {
  readonly repository: string;
  readonly cacheRoot: string;
  readonly mirrorPath: string;
}): Promise<void> {
  const stagingRoot = await mkdtemp(
    path.join(options.cacheRoot, '.mirror-staging-'),
  );
  const stagedMirror = path.join(stagingRoot, 'repository.git');
  try {
    await runChecked(
      'git',
      ['clone', '--mirror', options.repository, stagedMirror],
      { cwd: stagingRoot, ...GIT_OPTIONS },
    );
    try {
      await rename(stagedMirror, options.mirrorPath);
    } catch (error) {
      if (!(await pathExists(options.mirrorPath))) throw error;
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function mirrorHasRevision(
  mirrorPath: string,
  revision: string,
): Promise<boolean> {
  const execution = await runProcess(
    'git',
    ['-C', mirrorPath, 'cat-file', '-e', `${revision}^{commit}`],
    { cwd: mirrorPath, capture: true, ...GIT_OPTIONS },
  );
  return execution.result.exitCode === 0 && !execution.result.timedOut;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}
