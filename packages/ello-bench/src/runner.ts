import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AgentAdapterError,
  type AgentProcessExecution,
  type NormalizedAgentExecution,
  type PreparedAgent,
} from './agents/adapter.js';
import { createAgentAdapter } from './agents/factory.js';
import type {
  AgentSpec,
  EvidenceDegradation,
  InfrastructureFailure,
  RunManifest,
  RunProvenance,
} from './contracts.js';
import { removeContainer } from './docker-image.js';
import { writeJsonAtomic, errorMessage } from './io.js';
import { capturePatch } from './patch.js';
import { PhaseTimingsRecorder } from './phase-timings.js';
import { invalidateRun, transitionRun, updateRun } from './run-state.js';
import type { ResolvedTaskFiles } from './task-corpus.js';
import { VerifierExecutionError } from './verifier-process.js';
import { runVerifier } from './verifier.js';
import { prepareTaskWorkspace } from './workspace.js';

type RunOutcome = NonNullable<RunManifest['outcome']>;

export async function runBenchmarkJob(options: {
  readonly manifest: RunManifest;
  readonly agent: AgentSpec;
  readonly provenance: RunProvenance;
  readonly taskFiles: ResolvedTaskFiles;
  readonly runtime: 'docker' | 'local';
}): Promise<RunManifest> {
  let manifest = options.manifest;
  let preparedAgent: PreparedAgent | undefined;
  let containerName: string | undefined;
  let phase = 'prepare-attempt';
  let pendingFailure: InfrastructureFailure | undefined;
  const rawRoot = path.join(manifest.attemptRoot, 'raw');
  const rawAgentRoot = path.join(rawRoot, 'agent');
  const taskEvidenceRoot = path.join(rawRoot, 'task');
  const harnessRoot = path.join(rawRoot, 'harness');
  const timings = new PhaseTimingsRecorder(
    path.join(rawRoot, 'phase-timings.json'),
  );
  try {
    await runPhase('prepare-attempt', async () => {
      await mkdir(taskEvidenceRoot, { recursive: true });
      await writeFile(
        path.join(taskEvidenceRoot, 'instruction.md'),
        options.taskFiles.instruction,
        'utf8',
      );
      await writeJsonAtomic(
        path.join(taskEvidenceRoot, 'resolved-task.json'),
        options.taskFiles.task,
      );
      manifest = await transitionRun(manifest, 'preparing', {
        phase,
        startedAt: new Date().toISOString(),
        agent: options.agent,
        provenance: options.provenance,
        task: options.taskFiles.task,
        executionRuntime: options.runtime,
        phaseTimingsPath: timings.path,
      });
    });

    const preparedWorkspace = await runPhase('prepare-workspace', async () => {
      manifest = await updateRun(manifest, { phase });
      return prepareTaskWorkspace({
        attemptId: manifest.attemptId,
        workspace: manifest.workspace,
        taskFiles: options.taskFiles,
        runtime: options.runtime,
      });
    });
    if (preparedWorkspace.runtime === 'docker') {
      containerName = preparedWorkspace.containerName;
      await writeJsonAtomic(path.join(rawRoot, 'docker-preflight.json'), {
        schema: 'ello.benchmark.docker-preflight.v1',
        containerName: preparedWorkspace.containerName,
        image: options.taskFiles.task.environment.image,
        imageId: preparedWorkspace.imageId,
        baseCommitHash: options.taskFiles.task.baseCommitHash,
        baselineTree: preparedWorkspace.baselineTree,
        initialGitStatus: preparedWorkspace.initialGitStatus,
        containerWorkspace: preparedWorkspace.containerWorkspace,
        containerUser: preparedWorkspace.containerUser,
        network: preparedWorkspace.network,
        cpus: options.taskFiles.task.environment.cpus,
        memoryMb: options.taskFiles.task.environment.memoryMb,
        storageMb: options.taskFiles.task.environment.storageMb,
      });
    } else {
      await writeJsonAtomic(path.join(rawRoot, 'local-preflight.json'), {
        schema: 'ello.benchmark.local-preflight.v1',
        repositoryUrl: options.taskFiles.task.repositoryUrl,
        baseCommitHash: options.taskFiles.task.baseCommitHash,
        baselineTree: preparedWorkspace.baselineTree,
        initialGitStatus: preparedWorkspace.initialGitStatus,
        workspace: preparedWorkspace.workspace,
      });
    }

    const agentContextBase = {
      attemptId: manifest.attemptId,
      agent: options.agent,
      agentConfigHash: manifest.job.agentConfigHash,
      agentStateRoot: manifest.agentStateRoot,
      workspace: manifest.workspace,
      rawAgentRoot,
      taskFiles: options.taskFiles,
    } as const;
    preparedAgent = await runPhase('prepare-agent', () =>
      createAgentAdapter(options.agent).prepare(
        preparedWorkspace.runtime === 'docker'
          ? {
              ...agentContextBase,
              runtime: preparedWorkspace.runtime,
              containerName: preparedWorkspace.containerName,
              containerWorkspace: preparedWorkspace.containerWorkspace,
            }
          : { ...agentContextBase, runtime: preparedWorkspace.runtime },
      ),
    );
    manifest = await transitionRun(manifest, 'running', {
      phase: 'agent-running',
      ...(preparedWorkspace.runtime === 'docker'
        ? {
            imageId: preparedWorkspace.imageId,
            containerName: preparedWorkspace.containerName,
          }
        : {}),
      baselineTree: preparedWorkspace.baselineTree,
    });

    let execution: AgentProcessExecution | undefined;
    try {
      execution = await runPhase('agent-running', () =>
        requiredPreparedAgent(preparedAgent).run(),
      );
    } catch (error) {
      pendingFailure = failureForError(phase, error);
    }
    try {
      await runPhase('close-agent', () =>
        requiredPreparedAgent(preparedAgent).close(),
      );
    } catch (error) {
      pendingFailure ??= failureForError(phase, error);
    }
    manifest = await transitionRun(manifest, 'capturing', {
      phase: 'capture-evidence',
      ...(execution === undefined ? {} : { client: execution.process }),
      ...(execution === undefined ? {} : { agentProcess: execution.artifact }),
    });

    const patch = await runPhase('capture-patch', () =>
      capturePatch({
        workspace: manifest.workspace,
        baselineTree: preparedWorkspace.baselineTree,
        patchPath: path.join(rawRoot, 'model.patch'),
        statusPath: path.join(rawRoot, 'git-status.txt'),
      }),
    );
    if (pendingFailure !== undefined || execution === undefined) {
      return await invalidateRun(
        await updateRun(manifest, { patch, phase }),
        pendingFailure ?? {
          kind: 'agent_process',
          phase,
          message: 'Agent process result is missing.',
        },
      );
    }

    let normalized: NormalizedAgentExecution | undefined;
    let evidenceDegradation: EvidenceDegradation | undefined;
    try {
      normalized = await runPhase('normalize-agent-evidence', () =>
        requiredPreparedAgent(preparedAgent).normalize(execution),
      );
    } catch (error) {
      // The patch is already on disk, so the experiment is still scoreable.
      // Losing evidence costs observability, not validity.
      evidenceDegradation = {
        phase: 'normalize-agent-evidence',
        message: errorMessage(error),
      };
      await writeFailureLog(rawRoot, 'agent-evidence-error.log', error);
    }
    if (normalized !== undefined && normalized.toolAudit.status === 'failed') {
      return await invalidateRun(
        await updateRun(manifest, {
          phase,
          agentRuntime: normalized.runtime,
          agentEvidence: normalized.evidenceArtifact,
          toolAudit: normalized.toolAuditArtifact,
          patch,
        }),
        {
          kind: 'agent_environment',
          phase: 'agent-tool-audit',
          message: normalized.toolAudit.violations
            .map((violation) => violation.detail)
            .join(' '),
        },
      );
    }
    if (normalized?.providerFailure === true) {
      return await invalidateRun(
        await updateRun(manifest, {
          phase,
          agentRuntime: normalized.runtime,
          agentEvidence: normalized.evidenceArtifact,
          toolAudit: normalized.toolAuditArtifact,
          patch,
        }),
        {
          kind: 'provider',
          phase: 'agent-model-call',
          message: requiredProviderFailureMessage(normalized),
        },
      );
    }

    manifest = await transitionRun(manifest, 'verifying', {
      phase: 'verifier-running',
      ...(normalized === undefined
        ? {}
        : {
            agentRuntime: normalized.runtime,
            agentEvidence: normalized.evidenceArtifact,
            toolAudit: normalized.toolAuditArtifact,
          }),
      ...(evidenceDegradation === undefined ? {} : { evidenceDegradation }),
      patch,
    });
    const harness = await runPhase('verifier-running', () =>
      runVerifier({
        attemptId: manifest.attemptId,
        harnessRoot,
        taskFiles: options.taskFiles,
        patch,
        runtime: options.runtime,
      }),
    );
    await writeJsonAtomic(harness.reportPath, harness);

    if (preparedWorkspace.runtime === 'docker') {
      await runPhase('cleanup-agent-container', async () => {
        await removeContainer(preparedWorkspace.containerName);
        containerName = undefined;
      });
    }
    const outcome = classifyOutcome(execution.process, harness.reward);
    return await transitionRun(manifest, 'completed', {
      phase: 'completed',
      completedAt: new Date().toISOString(),
      verifierProcess: harness.verifierProcess,
      harness,
      outcome,
    });
  } catch (error) {
    if (error instanceof VerifierExecutionError) {
      manifest = await updateRun(manifest, {
        verifierProcess: error.processEvidence,
      });
    }
    const invalidFailure = pendingFailure ?? failureForError(phase, error);
    if (preparedAgent !== undefined) {
      try {
        await preparedAgent.close();
      } catch (closeError) {
        await writeFailureLog(rawRoot, 'agent-close-error.log', closeError);
      }
    }
    if (
      manifest.status !== 'completed' &&
      manifest.status !== 'invalid_infrastructure'
    ) {
      return await invalidateRun(manifest, invalidFailure);
    }
    throw error;
  } finally {
    const cleanupContainerName = containerName;
    if (cleanupContainerName !== undefined) {
      try {
        await runPhase('cleanup-agent-container-finalizer', () =>
          removeContainer(cleanupContainerName),
        );
      } catch (error) {
        await writeFailureLog(rawRoot, 'container-cleanup-error.log', error);
      }
    }
  }

  async function runPhase<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    phase = name;
    return timings.run(name, operation);
  }
}

function requiredProviderFailureMessage(
  normalized: NormalizedAgentExecution,
): string {
  if (normalized.providerFailureMessage === null) {
    throw new Error('Provider failure is missing its diagnostic message.');
  }
  return normalized.providerFailureMessage;
}

function requiredPreparedAgent(
  prepared: PreparedAgent | undefined,
): PreparedAgent {
  if (prepared === undefined) throw new Error('Agent is not prepared.');
  return prepared;
}

function classifyOutcome(
  process: NonNullable<RunManifest['client']>,
  reward: 0 | 1,
): RunOutcome {
  if (process.timedOut)
    return reward === 1 ? 'timeout_passed' : 'timeout_failed';
  if (process.exitCode === 0) return reward === 1 ? 'passed' : 'failed';
  return reward === 1 ? 'agent_error_passed' : 'agent_error_failed';
}

function failureForError(phase: string, error: unknown): InfrastructureFailure {
  if (error instanceof AgentAdapterError) {
    return { kind: error.kind, phase, message: error.message };
  }
  return { kind: classifyPhase(phase), phase, message: errorMessage(error) };
}

function classifyPhase(phase: string): InfrastructureFailure['kind'] {
  if (phase.includes('corpus')) return 'corpus';
  if (phase.includes('container')) return 'container';
  if (phase.includes('workspace')) return 'workspace';
  if (phase.includes('agent')) return 'agent_process';
  if (phase.includes('provider')) return 'provider';
  if (phase.includes('config')) return 'config';
  if (phase.includes('event')) return 'recorder';
  if (phase.includes('patch')) return 'patch';
  if (phase.includes('verifier')) return 'verifier';
  return 'runner';
}

async function writeFailureLog(
  rawRoot: string,
  name: string,
  error: unknown,
): Promise<void> {
  await mkdir(rawRoot, { recursive: true });
  await writeFile(path.join(rawRoot, name), `${errorMessage(error)}\n`, 'utf8');
}
