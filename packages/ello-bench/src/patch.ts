import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PatchArtifactSchema, type PatchArtifact } from './contracts.js';
import { sha256 } from './hash.js';
import { runChecked } from './process.js';

const GIT_OPTIONS = {
  timeoutMs: 5 * 60_000,
  killGraceMs: 5_000,
  maxOutputBytes: 512 * 1024 * 1024,
} as const;

export async function capturePatch(options: {
  readonly workspace: string;
  readonly baselineTree: string;
  readonly patchPath: string;
  readonly statusPath: string;
}): Promise<PatchArtifact> {
  const workspace = path.resolve(options.workspace);
  const status = (
    await runChecked('git', ['-C', workspace, 'status', '--short'], {
      cwd: workspace,
      ...GIT_OPTIONS,
    })
  ).stdout;
  await mkdir(path.dirname(options.statusPath), { recursive: true });
  await writeFile(options.statusPath, status, 'utf8');
  await runChecked('git', ['-C', workspace, 'add', '-A'], {
    cwd: workspace,
    ...GIT_OPTIONS,
  });
  const patch = (
    await runChecked(
      'git',
      ['-C', workspace, 'diff', '--cached', '--binary', options.baselineTree],
      { cwd: workspace, ...GIT_OPTIONS },
    )
  ).stdout;
  const names = (
    await runChecked(
      'git',
      [
        '-C',
        workspace,
        'diff',
        '--cached',
        '--name-only',
        '-z',
        options.baselineTree,
      ],
      { cwd: workspace, ...GIT_OPTIONS },
    )
  ).stdout;
  await mkdir(path.dirname(options.patchPath), { recursive: true });
  await writeFile(options.patchPath, patch, 'utf8');
  const bytes = await readFile(options.patchPath);
  return PatchArtifactSchema.parse({
    path: path.resolve(options.patchPath),
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    changedFiles: names.split('\0').filter((name) => name !== ''),
    baselineTree: options.baselineTree,
  });
}
