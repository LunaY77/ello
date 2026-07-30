import type {
  EvidenceDegradation,
  InfrastructureFailure,
  RunManifest,
} from '../domain/contract/index.js';
import { lastVerificationRound } from '../domain/evidence/verification-round.js';
import { classifyAttempt } from '../domain/scoring/attempt-outcome.js';
import {
  type AgentAdapterFailure,
  type AgentProcessExecution,
  type NormalizedAgentExecution,
  type PreparedAgent,
} from '../ports/agent.js';
import type {
  RunAttemptRequest,
  RunAttemptServices,
} from '../ports/attempt.js';
import type { VerifierFailure } from '../ports/verifier.js';

type RunOutcome = NonNullable<RunManifest['outcome']>;

export async function runAttempt(
  options: RunAttemptRequest,
  services: RunAttemptServices,
): Promise<RunManifest> {
  let manifest = options.manifest;
  let preparedAgent: PreparedAgent | undefined;
  let container: import('../ports/container.js').ContainerHandle | undefined;
  let phase = 'prepare-attempt';
  let pendingFailure: InfrastructureFailure | undefined;
  let closeFailure: InfrastructureFailure | undefined;
  const paths = services.paths.resolve(manifest, options.runRoot);
  const timings = services.phases.create(paths.phaseTimings);
  try {
    await runPhase('prepare-attempt', async () => {
      await services.artifacts.writeText(
        paths.taskInstruction,
        options.taskFiles.instruction,
      );
      await services.artifacts.writeJson(
        paths.resolvedTask,
        options.taskFiles.task,
      );
      manifest = await services.runs.transition(manifest, 'preparing', {
        phase,
        startedAt: services.clock.now().toISOString(),
        agent: options.agent,
        provenance: options.provenance,
        task: options.taskFiles.task,
        executionRuntime: 'docker',
        phaseTimingsPath: timings.path,
      });
    });

    const preparedWorkspace = await runPhase('prepare-workspace', async () => {
      manifest = await services.runs.update(manifest, { phase });
      return services.workspace.prepare({
        attemptId: manifest.attemptId,
        workspace: manifest.workspace,
        taskFiles: options.taskFiles,
        pullPolicy: options.pullPolicy,
      });
    });
    container = preparedWorkspace.container;
    await services.artifacts.writeJson(paths.dockerPreflight, {
      schema: 'ello.benchmark.docker-preflight.v1',
      containerName: preparedWorkspace.container.name,
      image: options.taskFiles.task.environment.image,
      imageId: preparedWorkspace.imageId,
      baseCommitHash: options.taskFiles.task.baseCommitHash,
      baselineTree: preparedWorkspace.baselineTree,
      initialGitStatus: preparedWorkspace.initialGitStatus,
      containerWorkspace: preparedWorkspace.container.workspace,
      containerUser: preparedWorkspace.containerUser,
      network: preparedWorkspace.network,
      cpus: options.taskFiles.task.environment.cpus,
      memoryMb: options.taskFiles.task.environment.memoryMb,
      storageMb: options.taskFiles.task.environment.storageMb,
      storagePolicy: preparedWorkspace.container.storagePolicy,
    });
    await services.artifacts.writeJson(paths.networkPolicy, {
      schema: 'ello.benchmark.network-policy.v1',
      allowInternet: options.taskFiles.task.environment.allowInternet,
      network: preparedWorkspace.network,
      containerName: preparedWorkspace.container.name,
    });

    const agentContextBase = {
      attemptId: manifest.attemptId,
      agent: options.agent,
      agentConfigHash: manifest.job.agentConfigHash,
      agentStateRoot: manifest.agentStateRoot,
      workspace: manifest.workspace,
      rawAgentRoot: paths.rawAgentRoot,
      taskFiles: options.taskFiles,
    } as const;
    preparedAgent = await runPhase('prepare-agent', () =>
      services.agents.create(options.agent).prepare({
        ...agentContextBase,
        container: preparedWorkspace.container,
      }),
    );
    manifest = await services.runs.transition(manifest, 'running', {
      phase: 'agent-running',
      imageId: preparedWorkspace.imageId,
      containerName: preparedWorkspace.container.name,
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
      closeFailure = failureForError(phase, error);
    }
    await runPhase('audit-workspace-storage', () =>
      preparedWorkspace.container.assertStorageLimit(),
    );
    manifest = await services.runs.transition(manifest, 'capturing', {
      phase: 'capture-evidence',
      ...(execution === undefined ? {} : { client: execution.process }),
      ...(execution === undefined ? {} : { agentProcess: execution.artifact }),
    });

    const patch = await runPhase('capture-patch', () =>
      services.patches.capture({
        workspace: manifest.workspace,
        baselineTree: preparedWorkspace.baselineTree,
        patchPath: paths.patch,
        statusPath: paths.gitStatus,
      }),
    );
    if (pendingFailure !== undefined || execution === undefined) {
      return await services.runs.invalidate(
        await services.runs.update(manifest, { patch, phase }),
        pendingFailure ??
          closeFailure ?? {
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
      await writeFailureLog(
        services,
        paths.failureLog('agent-evidence-error.log'),
        error,
      );
    }
    if (normalized !== undefined && normalized.toolAudit.status === 'failed') {
      return await services.runs.invalidate(
        await services.runs.update(manifest, {
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
      return await services.runs.invalidate(
        await services.runs.update(manifest, {
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
    if (closeFailure !== undefined) {
      return await services.runs.invalidate(
        await services.runs.update(manifest, {
          phase,
          ...(normalized === undefined
            ? {}
            : {
                agentRuntime: normalized.runtime,
                agentEvidence: normalized.evidenceArtifact,
                toolAudit: normalized.toolAuditArtifact,
              }),
          ...(evidenceDegradation === undefined ? {} : { evidenceDegradation }),
          patch,
        }),
        closeFailure,
      );
    }

    manifest = await services.runs.transition(manifest, 'verifying', {
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
      services.verifier.run({
        attemptId: manifest.attemptId,
        harnessRoot: paths.harnessRoot,
        gitCacheRoot: paths.gitCacheRoot,
        taskFiles: options.taskFiles,
        patch,
        lastAgentVerificationRound:
          normalized === undefined
            ? null
            : lastVerificationRound(normalized.rounds),
      }),
    );
    await services.artifacts.writeJson(harness.reportPath, harness);

    const attemptOutcome = classifyAttempt(harness);
    if (attemptOutcome.kind === 'invalid') {
      return await services.runs.invalidate(
        await services.runs.update(manifest, {
          phase: 'verifier-baseline',
          verifierProcess: harness.verifierProcess,
          harness,
        }),
        {
          kind: 'verifier',
          phase: 'verifier-baseline',
          message: `baseline-unhealthy: verifier baseline exited ${attemptOutcome.exitCode}.`,
        },
      );
    }

    if (options.cleanupPolicy !== 'never') {
      await runPhase('cleanup-agent-container', async () => {
        await preparedWorkspace.container.remove();
        container = undefined;
      });
    }
    const outcome = classifyOutcome(execution.process, attemptOutcome.reward);
    return await services.runs.transition(manifest, 'completed', {
      phase: 'completed',
      completedAt: services.clock.now().toISOString(),
      verifierProcess: harness.verifierProcess,
      harness,
      outcome,
    });
  } catch (error) {
    if (isVerifierFailure(error)) {
      manifest = await services.runs.update(manifest, {
        verifierProcess: error.processEvidence,
      });
    }
    const invalidFailure = pendingFailure ?? failureForError(phase, error);
    if (preparedAgent !== undefined) {
      try {
        await preparedAgent.close();
      } catch (closeError) {
        await writeFailureLog(
          services,
          paths.failureLog('agent-close-error.log'),
          closeError,
        );
      }
    }
    if (
      manifest.status !== 'completed' &&
      manifest.status !== 'invalid_infrastructure'
    ) {
      return await services.runs.invalidate(manifest, invalidFailure);
    }
    throw error;
  } finally {
    const cleanupContainer = container;
    if (cleanupContainer !== undefined && options.cleanupPolicy === 'always') {
      try {
        await runPhase('cleanup-agent-container-finalizer', () =>
          cleanupContainer.remove(),
        );
      } catch (error) {
        await writeFailureLog(
          services,
          paths.failureLog('container-cleanup-error.log'),
          error,
        );
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
  if (isAgentAdapterFailure(error)) {
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
  services: RunAttemptServices,
  path: string,
  error: unknown,
): Promise<void> {
  await services.artifacts.writeText(path, `${errorMessage(error)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAgentAdapterFailure(error: unknown): error is AgentAdapterFailure {
  return (
    error instanceof Error &&
    'agentFailure' in error &&
    error.agentFailure === true &&
    'kind' in error
  );
}

function isVerifierFailure(error: unknown): error is VerifierFailure {
  return error instanceof Error && 'processEvidence' in error;
}
