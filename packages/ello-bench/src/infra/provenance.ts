import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RunProvenanceSchema,
  type RunProvenance,
} from '../domain/contract/index.js';
import { sha256 } from '../domain/hash.js';

import { runChecked } from './process.js';

export const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

const GIT_OPTIONS = {
  timeoutMs: 30_000,
  killGraceMs: 2_000,
  maxOutputBytes: 16 * 1024 * 1024,
} as const;

interface BuildInputs {
  readonly revision: string;
  readonly sourceTree: string;
  readonly lockfileSha256: string;
  readonly pnpmVersion: string;
  readonly packageVersions: {
    readonly agent: string;
    readonly tui: string;
    readonly bench: string;
  };
}

export async function collectRunProvenance(
  requireEllo: boolean,
): Promise<RunProvenance> {
  const inputs = await readBuildInputs();
  return RunProvenanceSchema.parse({
    elloRevision: inputs.revision,
    sourceTree: inputs.sourceTree,
    lockfileSha256: inputs.lockfileSha256,
    nodeVersion: process.versions.node,
    pnpmVersion: inputs.pnpmVersion,
    platform: process.platform,
    architecture: process.arch,
    scope: requireEllo ? 'ello' : 'bench-only',
    packages: requireEllo
      ? inputs.packageVersions
      : { bench: inputs.packageVersions.bench },
  });
}

async function readBuildInputs(): Promise<BuildInputs> {
  const [revision, sourceTree, pnpm, lockfile, agent, tui, bench] =
    await Promise.all([
      runChecked('git', ['rev-parse', 'HEAD'], {
        cwd: REPOSITORY_ROOT,
        ...GIT_OPTIONS,
      }),
      runChecked('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: REPOSITORY_ROOT,
        ...GIT_OPTIONS,
      }),
      runChecked('pnpm', ['--version'], {
        cwd: REPOSITORY_ROOT,
        ...GIT_OPTIONS,
      }),
      readFile(path.join(REPOSITORY_ROOT, 'pnpm-lock.yaml')),
      readPackageVersion('ello-agent'),
      readPackageVersion('ello-tui'),
      readPackageVersion('ello-bench'),
    ]);
  return {
    revision: revision.stdout.trim(),
    sourceTree: sourceTree.stdout.trim(),
    lockfileSha256: sha256(lockfile),
    pnpmVersion: pnpm.stdout.trim(),
    packageVersions: { agent, tui, bench },
  };
}

async function readPackageVersion(name: string): Promise<string> {
  const filePath = path.join(REPOSITORY_ROOT, 'packages', name, 'package.json');
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof parsed.version !== 'string' ||
    parsed.version === ''
  ) {
    throw new Error(`Package version is missing: ${filePath}`);
  }
  return parsed.version;
}
