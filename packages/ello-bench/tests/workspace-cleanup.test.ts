import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { cleanupAttemptWorkspaces } from '../src/infra/workspace.js';

describe('attempt workspace cleanup', () => {
  it('removes only the three disposable workspace directories', async () => {
    const attemptRoot = await mkdtemp(
      path.join(tmpdir(), 'ello-bench-workspace-cleanup-'),
    );
    const workspace = path.join(attemptRoot, 'workspace');
    const baselineRoot = path.join(attemptRoot, 'raw', 'baseline-preflight');
    const harnessRoot = path.join(attemptRoot, 'raw', 'harness');
    const removable = [
      path.join(workspace, 'source.txt'),
      path.join(baselineRoot, 'workspace', 'baseline.txt'),
      path.join(harnessRoot, 'workspace', 'verifier.txt'),
    ];
    const preserved = [
      path.join(attemptRoot, 'run.json'),
      path.join(attemptRoot, 'agent-state', 'thread.jsonl'),
      path.join(attemptRoot, 'raw', 'agent', 'stdout.jsonl'),
      path.join(baselineRoot, 'stdout.log'),
      path.join(baselineRoot, 'tests', 'baseline.sh'),
      path.join(harnessRoot, 'report.json'),
      path.join(harnessRoot, 'logs', 'verifier', 'reward.txt'),
      path.join(attemptRoot, 'raw', 'model.patch'),
    ];
    for (const file of [...removable, ...preserved]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'fixture\n', 'utf8');
    }

    await cleanupAttemptWorkspaces({ attemptRoot, workspace });

    await Promise.all(
      removable.map(async (file) => {
        await expect(access(file)).rejects.toThrow();
      }),
    );
    await Promise.all(
      preserved.map((file) => expect(access(file)).resolves.toBeUndefined()),
    );
  });

  it('is idempotent when workspace directories are already absent', async () => {
    const attemptRoot = await mkdtemp(
      path.join(tmpdir(), 'ello-bench-workspace-cleanup-'),
    );

    await cleanupAttemptWorkspaces({
      attemptRoot,
      workspace: path.join(attemptRoot, 'workspace'),
    });
  });

  it('rejects a primary workspace outside the attempt root', async () => {
    const attemptRoot = await mkdtemp(
      path.join(tmpdir(), 'ello-bench-workspace-cleanup-'),
    );
    const outside = await mkdtemp(
      path.join(tmpdir(), 'ello-bench-workspace-outside-'),
    );
    const sentinel = path.join(outside, 'keep.txt');
    await writeFile(sentinel, 'keep\n', 'utf8');

    await expect(
      cleanupAttemptWorkspaces({ attemptRoot, workspace: outside }),
    ).rejects.toThrow(/cleanup path mismatch/u);
    await expect(access(sentinel)).resolves.toBeUndefined();
  });
});
