import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  HarnessReportSchema,
  type HarnessReport,
  type PatchArtifact,
} from '../../domain/contract/index.js';
import { sha256 } from '../../domain/hash.js';
import type { ResolvedTaskFiles } from '../../ports/corpus.js';
import { errorMessage } from '../io.js';

import { collectVerifierAssertions } from './assertions.js';
import {
  executeBaselineVerifierProcess,
  executeVerifierProcess,
  VerifierExecutionError,
} from './process.js';
import {
  prepareBaselineVerifierWorkspace,
  prepareVerifierWorkspace,
  sealVerifierPatchArtifact,
} from './workspace.js';

export async function runVerifier(options: {
  readonly attemptId: string;
  readonly harnessRoot: string;
  readonly gitCacheRoot: string;
  readonly taskFiles: ResolvedTaskFiles;
  readonly patch: PatchArtifact;
  readonly lastAgentVerificationRound: number | null;
}): Promise<HarnessReport> {
  const task = options.taskFiles.task;
  const prepared = await prepareVerifierWorkspace(options);
  const process = await executeVerifierProcess({
    attemptId: options.attemptId,
    harnessRoot: prepared.harnessRoot,
    workspace: prepared.workspace,
    tests: prepared.tests,
    logs: prepared.logs,
    inputPatchPath: prepared.inputPatchPath,
    task,
  });
  try {
    const reward = await readReward(prepared.verifierOutput);
    const verifierPatchPath = path.join(prepared.artifacts, 'model.patch');
    const verifierGeneratedPatchPath = path.join(
      prepared.artifacts,
      'verifier-generated-model.patch',
    );
    let verifierGeneratedPatchSha256: string | null = null;
    try {
      await copyFile(verifierPatchPath, verifierGeneratedPatchPath);
      verifierGeneratedPatchSha256 = sha256(
        await readFile(verifierGeneratedPatchPath),
      );
    } catch {
      // Some verifier contracts do not generate their own patch artifact.
    }
    const verifierCapturedPatchSha256 = await sealVerifierPatchArtifact({
      inputPatchPath: prepared.inputPatchPath,
      artifactPatchPath: verifierPatchPath,
      expectedSha256: options.patch.sha256,
    });
    return HarnessReportSchema.parse({
      schema: 'ello.benchmark.harness.v1',
      taskId: task.taskId,
      status: reward === 1 ? 'passed' : 'failed',
      reward,
      verifierProcess: process.reference,
      verifierRuntime: 'docker',
      verifierImage: task.environment.image,
      verifierImageId: prepared.imageId,
      modelPatchSha256: options.patch.sha256,
      appliedPatchSha256: prepared.appliedPatchSha256,
      verifierCapturedPatchSha256,
      verifierGeneratedPatchSha256,
      baselineTestExitCode: process.baselineExitCode,
      newTestsExitCode: process.newTestsExitCode,
      hiddenPatchChangedFiles: prepared.hiddenPatchChangedFiles,
      patchConflictFiles: prepared.patchConflictFiles,
      modelPatchChangedFiles: options.patch.changedFiles,
      verifierAssertions: await collectVerifierAssertions({
        verifierOutput: prepared.verifierOutput,
        baselineExitCode: process.baselineExitCode,
        newTestsExitCode: process.newTestsExitCode,
        reward,
        ...(options.taskFiles.benchmark === 'swe-bench-pro'
          ? { testSpec: options.taskFiles.testSpec }
          : {}),
      }),
      lastAgentVerificationRound: options.lastAgentVerificationRound,
      reportPath: path.join(prepared.harnessRoot, 'report.json'),
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    throw new VerifierExecutionError(errorMessage(error), process.reference);
  }
}

export const dockerVerifierRuntime: import('../../ports/verifier.js').VerifierRuntime =
  {
    preflight: runVerifierBaselinePreflight,
    run: runVerifier,
  };

async function runVerifierBaselinePreflight(options: {
  readonly attemptId: string;
  readonly harnessRoot: string;
  readonly taskFiles: ResolvedTaskFiles;
  readonly baselineTree: string;
}) {
  const prepared = await prepareBaselineVerifierWorkspace(options);
  const process = await executeBaselineVerifierProcess({
    attemptId: options.attemptId,
    harnessRoot: prepared.harnessRoot,
    workspace: prepared.workspace,
    tests: prepared.tests,
    logs: prepared.logs,
    task: options.taskFiles.task,
  });
  return {
    process: process.reference,
    exitCode: process.baselineExitCode,
    imageId: prepared.imageId,
  };
}

async function readReward(directory: string): Promise<0 | 1> {
  const value = (
    await readFile(path.join(directory, 'reward.txt'), 'utf8')
  ).trim();
  if (value !== '0' && value !== '1') {
    throw new Error(
      `Verifier reward must be 0 or 1, received ${JSON.stringify(value)}.`,
    );
  }
  return value === '1' ? 1 : 0;
}
