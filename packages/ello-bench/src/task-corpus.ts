import { access, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { BenchmarkConfig, TaskDeclaration } from './contracts.js';
import { runChecked } from './process.js';
import { getBenchmarkSuite, type ResolvedTaskFiles } from './suite.js';

const PROCESS_OPTIONS = {
  timeoutMs: 30 * 60_000,
  killGraceMs: 5_000,
  maxOutputBytes: 128 * 1024 * 1024,
} as const;

export type { ResolvedTaskFiles } from './suite.js';

export async function ensureTaskCorpus(options: {
  readonly corpusRoot: string;
  readonly source: BenchmarkConfig['suite']['source'];
}): Promise<string> {
  const corpusRoot = path.resolve(options.corpusRoot);
  const gitDir = path.join(corpusRoot, '.git');
  let created = false;
  if (!(await exists(gitDir))) {
    if ((await exists(corpusRoot)) && (await readdir(corpusRoot)).length > 0) {
      throw new Error(
        `Corpus root is not an empty Git checkout: ${corpusRoot}`,
      );
    }
    await mkdir(path.dirname(corpusRoot), { recursive: true });
    await runChecked(
      'git',
      [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        options.source.repository,
        corpusRoot,
      ],
      { cwd: path.dirname(corpusRoot), ...PROCESS_OPTIONS },
    );
    created = true;
  }

  const origin = (
    await runChecked('git', ['-C', corpusRoot, 'remote', 'get-url', 'origin'], {
      cwd: corpusRoot,
      ...PROCESS_OPTIONS,
    })
  ).stdout.trim();
  if (
    normalizeRepository(origin) !==
    normalizeRepository(options.source.repository)
  ) {
    throw new Error(
      `Corpus origin mismatch: expected ${options.source.repository}, received ${origin}.`,
    );
  }

  const head = await readHead(corpusRoot);
  if (!created) await assertCorpusStatusClean(corpusRoot);
  if (head !== options.source.revision) {
    await runChecked(
      'git',
      [
        '-C',
        corpusRoot,
        'fetch',
        '--depth=1',
        'origin',
        options.source.revision,
      ],
      { cwd: corpusRoot, ...PROCESS_OPTIONS },
    );
  }
  if (created || head !== options.source.revision) {
    await runChecked(
      'git',
      ['-C', corpusRoot, 'checkout', '--detach', options.source.revision],
      { cwd: corpusRoot, ...PROCESS_OPTIONS },
    );
  }
  await assertCorpusStatusClean(corpusRoot);
  const verifiedHead = await readHead(corpusRoot);
  if (verifiedHead !== options.source.revision) {
    throw new Error(
      `Corpus revision mismatch: expected ${options.source.revision}, received ${verifiedHead}.`,
    );
  }
  return corpusRoot;
}

export async function loadResolvedTask(
  corpusRoot: string,
  config: BenchmarkConfig,
  declaration: TaskDeclaration,
): Promise<ResolvedTaskFiles> {
  return getBenchmarkSuite(config.suite.id).loadTask(corpusRoot, declaration);
}

export async function validateCorpusTasks(
  corpusRoot: string,
  config: BenchmarkConfig,
): Promise<ReadonlyMap<string, ResolvedTaskFiles>> {
  const suite = getBenchmarkSuite(config.suite.id);
  const loaded = await suite.loadTasks(corpusRoot);
  if (loaded.size !== config.tasks.length) {
    throw new Error(
      `Loaded task count mismatch: expected ${config.tasks.length}, received ${loaded.size}.`,
    );
  }
  return loaded;
}

async function assertCorpusStatusClean(corpusRoot: string): Promise<void> {
  const status = (
    await runChecked('git', ['-C', corpusRoot, 'status', '--porcelain'], {
      cwd: corpusRoot,
      ...PROCESS_OPTIONS,
    })
  ).stdout;
  if (status !== '') {
    throw new Error(`Corpus checkout has changes: ${corpusRoot}`);
  }
}

async function readHead(corpusRoot: string): Promise<string> {
  return (
    await runChecked('git', ['-C', corpusRoot, 'rev-parse', 'HEAD'], {
      cwd: corpusRoot,
      ...PROCESS_OPTIONS,
    })
  ).stdout.trim();
}

function normalizeRepository(repository: string): string {
  return repository.replace(/\.git$/u, '').replace(/\/$/u, '');
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}
