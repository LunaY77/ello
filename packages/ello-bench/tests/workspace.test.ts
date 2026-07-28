import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ResolvedTask } from '../src/contracts.js';
import { runChecked } from '../src/process.js';
import type { ResolvedTaskFiles } from '../src/suite.js';
import {
  prepareTaskWorkspace,
  taskContainerDockerArgs,
} from '../src/workspace.js';

const ENVIRONMENT = {
  image: 'example.invalid/swe-bench:task',
  allowInternet: false,
  buildTimeoutMs: 1_800_000,
  cpus: 2,
  memoryMb: 8192,
  storageMb: 20480,
} as const;

describe('task container Docker arguments', () => {
  it('runs the agent container as the host user so the shared Git repository stays writable', () => {
    const args = taskContainerDockerArgs({
      containerName: 'ello-bench-abc-agent',
      workspace: '/runs/job/workspace',
      network: 'none',
      containerUser: '1000:1000',
      task: resolvedTask('deep-swe'),
    });

    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');
    expect(args).toContain('type=bind,source=/runs/job/workspace,target=/app');
  });

  it('redirects HOME to a writable container path', () => {
    const args = taskContainerDockerArgs({
      containerName: 'ello-bench-abc-agent',
      workspace: '/runs/job/workspace',
      network: 'bridge',
      containerUser: '1000:1000',
      task: resolvedTask('deep-swe'),
    });

    const home = args[args.indexOf('--env') + 1];
    expect(home).toBe('HOME=/tmp/ello-bench-home');
    expect(home).not.toContain('/root');
  });

  it('starts SWE-bench Pro without a login shell', () => {
    const args = taskContainerDockerArgs({
      containerName: 'ello-bench-abc-agent',
      workspace: '/runs/job/workspace',
      network: 'none',
      containerUser: '1000:1000',
      task: resolvedTask('swe-bench-pro'),
    });

    expect(args.slice(-4)).toEqual([
      '/bin/bash',
      ENVIRONMENT.image,
      '-c',
      'sleep infinity',
    ]);
  });
});

describe('local task workspace', () => {
  it('clones the pinned repository and applies the public test patch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-local-workspace-'));
    const repository = path.join(root, 'repository');
    const workspace = path.join(root, 'workspace');
    await git(['init', repository], root);
    await git(['-C', repository, 'config', 'user.name', 'Benchmark'], root);
    await git(
      ['-C', repository, 'config', 'user.email', 'benchmark@example.test'],
      root,
    );
    await writeFile(path.join(repository, 'README.md'), 'base\n', 'utf8');
    await git(['-C', repository, 'add', 'README.md'], root);
    await git(['-C', repository, 'commit', '-m', 'base'], root);
    const revision = (
      await git(['-C', repository, 'rev-parse', 'HEAD'], root)
    ).trim();
    const taskFiles = {
      benchmark: 'swe-bench-pro',
      task: {
        benchmark: 'swe-bench-pro',
        repositoryUrl: pathToFileURL(repository).href,
        baseCommitHash: revision,
        environment: { storageMb: 1 },
      },
      instruction: 'Update the fixture.',
      runScriptPath: path.join(root, 'run.sh'),
      parserPath: path.join(root, 'parser.py'),
      workspaceSetupCommands: [],
      workspacePatch:
        'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-base\n+public test patch\n',
      testSpec: { selectedTests: [], failToPass: [], passToPass: [] },
    } as unknown as ResolvedTaskFiles;

    const prepared = await prepareTaskWorkspace({
      attemptId: 'a'.repeat(24),
      workspace,
      taskFiles,
      runtime: 'local',
    });

    expect(prepared.runtime).toBe('local');
    expect(await readFile(path.join(workspace, 'README.md'), 'utf8')).toBe(
      'public test patch\n',
    );
    expect(prepared.initialGitStatus).toBe(' M README.md\n');
    expect(prepared.baselineTree).toMatch(/^[0-9a-f]{40,64}$/u);
  });
});

function resolvedTask(benchmark: ResolvedTask['benchmark']): ResolvedTask {
  return { benchmark, environment: ENVIRONMENT } as ResolvedTask;
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  return (
    await runChecked('git', args, {
      cwd,
      timeoutMs: 30_000,
      killGraceMs: 2_000,
      maxOutputBytes: 16 * 1024 * 1024,
    })
  ).stdout;
}
