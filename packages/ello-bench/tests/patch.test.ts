import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PatchArtifactSchema } from '../src/domain/contract/index.js';
import { capturePatch } from '../src/infra/patch.js';
import { runChecked } from '../src/infra/process.js';

const GIT = {
  timeoutMs: 30_000,
  killGraceMs: 1_000,
  maxOutputBytes: 4 * 1024 * 1024,
} as const;

describe('patch capture', () => {
  it('captures tracked and untracked changes against a baseline tree', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'ello-bench-patch-'));
    await runChecked('git', ['init'], { cwd: workspace, ...GIT });
    await runChecked('git', ['config', 'user.email', 'bench@example.invalid'], {
      cwd: workspace,
      ...GIT,
    });
    await runChecked('git', ['config', 'user.name', 'Benchmark'], {
      cwd: workspace,
      ...GIT,
    });
    await writeFile(path.join(workspace, 'tracked.txt'), 'before\n', 'utf8');
    await runChecked('git', ['add', '-A'], { cwd: workspace, ...GIT });
    await runChecked('git', ['commit', '-m', 'base'], {
      cwd: workspace,
      ...GIT,
    });
    const baselineTree = (
      await runChecked('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: workspace,
        ...GIT,
      })
    ).stdout.trim();
    await writeFile(path.join(workspace, 'tracked.txt'), 'after\n', 'utf8');
    await writeFile(path.join(workspace, 'new.txt'), 'new\n', 'utf8');

    const patch = await capturePatch({
      workspace,
      baselineTree,
      patchPath: path.join(workspace, '..', 'model.patch'),
      statusPath: path.join(workspace, '..', 'status.txt'),
    });

    expect(patch.bytes).toBeGreaterThan(0);
    expect(patch.changedFiles).toEqual(['new.txt', 'tracked.txt']);
    expect(patch.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects benchmark state paths from model changes', () => {
    expect(() =>
      PatchArtifactSchema.parse({
        path: '/tmp/model.patch',
        sha256: 'a'.repeat(64),
        bytes: 1,
        changedFiles: ['.ello/session.json'],
        baselineTree: 'b'.repeat(40),
      }),
    ).toThrow('outside the task source contract');
  });
});
