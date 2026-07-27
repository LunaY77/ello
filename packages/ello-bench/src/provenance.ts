import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BuildManifestSchema,
  RunProvenanceSchema,
  type BuildManifest,
  type RunProvenance,
} from './contracts.js';
import { sha256 } from './hash.js';
import { runChecked } from './process.js';

export const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

const GIT_OPTIONS = {
  timeoutMs: 30_000,
  killGraceMs: 2_000,
  maxOutputBytes: 16 * 1024 * 1024,
} as const;

const BUILD_TARGETS = [
  {
    key: 'agent',
    packageDirectory: 'ello-agent',
    packageName: '@ello/agent',
    entries: ['index.js', 'main.js'],
  },
  {
    key: 'tui',
    packageDirectory: 'ello-tui',
    packageName: '@ello/tui',
    entries: ['index.js', 'cli/main.js'],
  },
  {
    key: 'bench',
    packageDirectory: 'ello-bench',
    packageName: '@ello/bench',
    entries: ['index.js', 'cli.js', 'server-entry.js'],
  },
] as const;

interface BuildInputs {
  readonly revision: string;
  readonly sourceTree: string;
  readonly status: string;
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
  if (inputs.status !== '') {
    throw new Error('Benchmark execution requires a clean Ello worktree.');
  }
  const builds = await validateBuildManifests(inputs, requireEllo);
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
    builds,
  });
}

export async function validateBuildManifests(
  providedInputs?: BuildInputs,
  requireEllo = true,
): Promise<
  | {
      readonly agent: BuildManifest;
      readonly tui: BuildManifest;
      readonly bench: BuildManifest;
    }
  | { readonly bench: BuildManifest }
> {
  const inputs = providedInputs ?? (await readBuildInputs());
  const [agentTarget, tuiTarget, benchTarget] = BUILD_TARGETS;
  const bench = await validateBuildManifest(benchTarget, inputs);
  if (!requireEllo) return { bench };
  const [agent, tui] = await Promise.all([
    validateBuildManifest(agentTarget, inputs),
    validateBuildManifest(tuiTarget, inputs),
  ]);
  return { agent, tui, bench };
}

async function validateBuildManifest(
  target: (typeof BUILD_TARGETS)[number],
  inputs: BuildInputs,
): Promise<BuildManifest> {
  const distRoot = path.join(
    REPOSITORY_ROOT,
    'packages',
    target.packageDirectory,
    'dist',
  );
  const manifestPath = path.join(distRoot, 'build-manifest.json');
  const manifest = BuildManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
  );
  if (
    manifest.packageName !== target.packageName ||
    manifest.packageVersion !== inputs.packageVersions[target.key]
  ) {
    throw new Error(`Build package identity mismatch: ${manifestPath}`);
  }
  if (
    manifest.gitRevision !== inputs.revision ||
    manifest.gitTree !== inputs.sourceTree
  ) {
    throw new Error(`Build source revision mismatch: ${manifestPath}`);
  }
  if (!manifest.sourceClean) {
    throw new Error(
      `Build was produced from a dirty worktree: ${manifestPath}`,
    );
  }
  if (manifest.lockfileSha256 !== inputs.lockfileSha256) {
    throw new Error(`Build lockfile checksum mismatch: ${manifestPath}`);
  }
  if (
    manifest.nodeVersion !== process.versions.node ||
    manifest.pnpmVersion !== inputs.pnpmVersion
  ) {
    throw new Error(`Build toolchain mismatch: ${manifestPath}`);
  }
  if (
    Object.keys(manifest.entries).sort().join('\n') !==
    [...target.entries].sort().join('\n')
  ) {
    throw new Error(`Build entry declaration mismatch: ${manifestPath}`);
  }
  for (const entry of target.entries) {
    const actual = sha256(await readFile(path.join(distRoot, entry)));
    if (manifest.entries[entry] !== actual) {
      throw new Error(`Build entry checksum mismatch: ${entry}`);
    }
  }
  return manifest;
}

async function readBuildInputs(): Promise<BuildInputs> {
  const [revision, sourceTree, pnpm, lockfile, agent, tui, bench, status] =
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
      runChecked('git', ['status', '--porcelain'], {
        cwd: REPOSITORY_ROOT,
        ...GIT_OPTIONS,
      }),
    ]);
  return {
    revision: revision.stdout.trim(),
    sourceTree: sourceTree.stdout.trim(),
    lockfileSha256: sha256(lockfile),
    pnpmVersion: pnpm.stdout.trim(),
    packageVersions: { agent, tui, bench },
    status: status.stdout,
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
