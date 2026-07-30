import path from 'node:path';

import { runAttempt } from '../application/run-attempt.js';
import {
  runBenchmarkMatrix as runMatrix,
  type MatrixRunResult,
} from '../application/run-matrix.js';
import type { BenchmarkConfig } from '../domain/contract/index.js';
import type {
  RunAttemptRequest,
  RunAttemptServices,
} from '../ports/attempt.js';

import { createAgentAdapter } from './agent/factory.js';
import { fsArtifactStore } from './artifact/fs.js';
import { systemClock } from './clock/system.js';
import { ensureTaskCorpus, validateCorpusTasks } from './corpus/git-corpus.js';
import { capturePatch } from './patch.js';
import { PhaseTimingsRecorder } from './phase-timings.js';
import { collectRunProvenance } from './provenance.js';
import {
  invalidateRun,
  openSuiteManifest,
  selectAttempt,
  transitionRun,
  updateRun,
} from './run-state.js';
import { dockerVerifierRuntime } from './verifier/docker.js';
import { prepareTaskWorkspace } from './workspace.js';

const services: RunAttemptServices = {
  agents: { create: createAgentAdapter },
  artifacts: fsArtifactStore,
  clock: systemClock,
  patches: { capture: capturePatch },
  paths: {
    resolve(manifest, runRoot) {
      const rawRoot = path.join(manifest.attemptRoot, 'raw');
      const taskRoot = path.join(rawRoot, 'task');
      return {
        rawRoot,
        rawAgentRoot: path.join(rawRoot, 'agent'),
        taskInstruction: path.join(taskRoot, 'instruction.md'),
        resolvedTask: path.join(taskRoot, 'resolved-task.json'),
        harnessRoot: path.join(rawRoot, 'harness'),
        phaseTimings: path.join(rawRoot, 'phase-timings.json'),
        patch: path.join(rawRoot, 'model.patch'),
        gitStatus: path.join(rawRoot, 'git-status.txt'),
        gitCacheRoot: path.join(runRoot, 'cache', 'git-mirrors'),
        dockerPreflight: path.join(rawRoot, 'docker-preflight.json'),
        networkPolicy: path.join(rawRoot, 'network-policy.json'),
        failureLog: (name) => path.join(rawRoot, name),
      };
    },
  },
  phases: { create: (filePath) => new PhaseTimingsRecorder(filePath) },
  runs: {
    transition: transitionRun,
    update: updateRun,
    invalidate: invalidateRun,
  },
  verifier: dockerVerifierRuntime,
  workspace: { prepare: prepareTaskWorkspace },
};

export function runBenchmarkJob(request: RunAttemptRequest) {
  return runAttempt(request, services);
}

const matrixRuntime: import('../ports/matrix.js').MatrixRuntime = {
  collectProvenance: collectRunProvenance,
  async loadTaskFiles(corpusRoot, config) {
    const resolvedCorpusRoot = await ensureTaskCorpus({
      corpusRoot,
      source: config.suite.source,
    });
    return validateCorpusTasks(resolvedCorpusRoot, config);
  },
  openSuite: openSuiteManifest,
  selectAttempt,
  runAttempt: runBenchmarkJob,
};

export function runBenchmarkMatrix(options: {
  readonly config: BenchmarkConfig;
  readonly runRoot: string;
  readonly corpusRoot: string;
  readonly taskIds: ReadonlySet<string>;
  readonly agentIds: ReadonlySet<string>;
}): Promise<MatrixRunResult> {
  return runMatrix(options, matrixRuntime);
}

export type { MatrixRunResult };
