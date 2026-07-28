import { copyFile } from 'node:fs/promises';
import path from 'node:path';

import type { PatchArtifact } from './contracts.js';
import { extractImageWorkspace } from './docker-image.js';
import { ensureEmptyDirectory } from './filesystem.js';
import { assertGitHead, captureBaselineTree } from './git-workspace.js';
import { sha256 } from './hash.js';
import { cloneLocalWorkspace } from './local-workspace.js';
import { runChecked } from './process.js';
import { getBenchmarkSuiteForTask } from './suite.js';
import type { ResolvedTaskFiles } from './task-corpus.js';

const GIT_OPTIONS = {
  timeoutMs: 5 * 60_000,
  killGraceMs: 5_000,
  maxOutputBytes: 512 * 1024 * 1024,
} as const;

interface PreparedVerifierWorkspaceBase {
  readonly runtime: 'docker' | 'local';
  readonly harnessRoot: string;
  readonly workspace: string;
  readonly tests: string;
  readonly logs: string;
  readonly artifacts: string;
  readonly verifierOutput: string;
  readonly appliedPatchSha256: string;
  readonly hiddenPatchChangedFiles: readonly string[];
  readonly patchConflictFiles: readonly string[];
}

export type PreparedVerifierWorkspace = PreparedVerifierWorkspaceBase &
  (
    | { readonly runtime: 'local' }
    | { readonly runtime: 'docker'; readonly imageId: string }
  );

export async function prepareVerifierWorkspace(options: {
  readonly attemptId: string;
  readonly harnessRoot: string;
  readonly gitCacheRoot: string;
  readonly taskFiles: ResolvedTaskFiles;
  readonly patch: PatchArtifact;
  readonly runtime: 'docker' | 'local';
}): Promise<PreparedVerifierWorkspace> {
  const task = options.taskFiles.task;
  const harnessRoot = path.resolve(options.harnessRoot);
  const workspace = path.join(harnessRoot, 'workspace');
  const tests = path.join(harnessRoot, 'tests');
  const logs = path.join(harnessRoot, 'logs');
  const input = path.join(logs, 'input');
  const artifacts = path.join(logs, 'artifacts');
  const verifierOutput = path.join(logs, 'verifier');
  await Promise.all(
    [tests, input, artifacts, verifierOutput].map(ensureEmptyDirectory),
  );

  const inputPatchPath = path.join(input, 'model.patch');
  await copyFile(options.patch.path, inputPatchPath);
  const suite = getBenchmarkSuiteForTask(task.benchmark);
  await suite.stageVerifier(options.taskFiles, tests);

  let imageId: string | undefined;
  if (options.runtime === 'docker') {
    imageId = await extractImageWorkspace({
      containerName: `ello-bench-${options.attemptId}-verify-seed`,
      image: task.environment.image,
      workspace,
      timeoutMs: task.environment.buildTimeoutMs,
    });
    await suite.prepareWorkspace(workspace, options.taskFiles, 'image');
  } else {
    await cloneLocalWorkspace({
      repository: task.repositoryUrl,
      revision: task.baseCommitHash,
      workspace,
      cacheRoot: options.gitCacheRoot,
    });
    await suite.prepareWorkspace(workspace, options.taskFiles, 'repository');
  }
  await assertGitHead(
    workspace,
    task.baseCommitHash,
    options.runtime === 'docker' ? 'Verifier image' : 'Local verifier checkout',
  );
  const baselineTree = await captureBaselineTree(workspace);
  if (baselineTree !== options.patch.baselineTree) {
    throw new Error(
      `Verifier baseline tree mismatch: ${baselineTree} versus ${options.patch.baselineTree}.`,
    );
  }

  const { hiddenPatchChangedFiles, patchConflictFiles } =
    await suite.auditVerifier({
      workspace,
      testsDirectory: tests,
      modelChangedFiles: options.patch.changedFiles,
    });
  if (options.patch.bytes > 0) {
    await runChecked(
      'git',
      ['-C', workspace, 'apply', '--whitespace=nowarn', inputPatchPath],
      { cwd: workspace, ...GIT_OPTIONS },
    );
  }
  await runChecked('git', ['-C', workspace, 'add', '-A'], {
    cwd: workspace,
    ...GIT_OPTIONS,
  });
  const appliedPatchSha256 = sha256(
    (
      await runChecked(
        'git',
        ['-C', workspace, 'diff', '--cached', '--binary', baselineTree],
        { cwd: workspace, ...GIT_OPTIONS },
      )
    ).stdout,
  );
  if (appliedPatchSha256 !== options.patch.sha256) {
    throw new Error(
      `Applied patch checksum mismatch: ${appliedPatchSha256} versus ${options.patch.sha256}.`,
    );
  }
  await runChecked('git', ['-C', workspace, 'reset', '--mixed', '-q', 'HEAD'], {
    cwd: workspace,
    ...GIT_OPTIONS,
  });

  const prepared = {
    harnessRoot,
    workspace,
    tests,
    logs,
    artifacts,
    verifierOutput,
    appliedPatchSha256,
    hiddenPatchChangedFiles,
    patchConflictFiles,
  } as const;
  return options.runtime === 'docker'
    ? {
        ...prepared,
        runtime: options.runtime,
        imageId: requiredImageId(imageId),
      }
    : { ...prepared, runtime: options.runtime };
}

function requiredImageId(imageId: string | undefined): string {
  if (imageId === undefined) throw new Error('Verifier image id is missing.');
  return imageId;
}
