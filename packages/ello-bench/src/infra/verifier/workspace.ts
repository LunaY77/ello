import { copyFile } from 'node:fs/promises';
import path from 'node:path';

import type { PatchArtifact } from '../../domain/contract/index.js';
import { sha256 } from '../../domain/hash.js';
import type { ResolvedTaskFiles } from '../../ports/corpus.js';
import { getBenchmarkSuiteForTask } from '../corpus/suite.js';
import { extractImageWorkspace } from '../docker-image.js';
import { ensureEmptyDirectory } from '../filesystem.js';
import { assertGitHead, captureBaselineTree } from '../git-workspace.js';
import { runChecked } from '../process.js';

const GIT_OPTIONS = {
  timeoutMs: 5 * 60_000,
  killGraceMs: 5_000,
  maxOutputBytes: 512 * 1024 * 1024,
} as const;

export interface PreparedVerifierWorkspace {
  readonly harnessRoot: string;
  readonly workspace: string;
  readonly tests: string;
  readonly logs: string;
  readonly artifacts: string;
  readonly verifierOutput: string;
  readonly appliedPatchSha256: string;
  readonly hiddenPatchChangedFiles: readonly string[];
  readonly patchConflictFiles: readonly string[];
  readonly imageId: string;
}

export async function prepareVerifierWorkspace(options: {
  readonly attemptId: string;
  readonly harnessRoot: string;
  readonly gitCacheRoot: string;
  readonly taskFiles: ResolvedTaskFiles;
  readonly patch: PatchArtifact;
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

  const imageId = await extractImageWorkspace({
    containerName: `ello-bench-${options.attemptId}-verify-seed`,
    image: task.environment.image,
    workspace,
    timeoutMs: task.environment.buildTimeoutMs,
  });
  await suite.prepareWorkspace(workspace, options.taskFiles, 'image');
  await assertGitHead(workspace, task.baseCommitHash, 'Verifier image');
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

  return {
    harnessRoot,
    workspace,
    tests,
    logs,
    artifacts,
    verifierOutput,
    appliedPatchSha256,
    hiddenPatchChangedFiles,
    patchConflictFiles,
    imageId,
  } as const;
}
