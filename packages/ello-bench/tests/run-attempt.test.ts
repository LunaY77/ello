import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runAttempt } from '../src/application/run-attempt.js';
import { RunManifestSchema } from '../src/domain/contract/index.js';
import { sha256, stableJson } from '../src/domain/hash.js';
import { fsArtifactStore } from '../src/infra/artifact/fs.js';
import type { RunAttemptServices } from '../src/ports/attempt.js';

describe('run attempt baseline preflight', () => {
  it('invalidates an unhealthy clean baseline before preparing the agent', async () => {
    const attemptRoot = await mkdtemp(
      path.join(tmpdir(), 'ello-bench-baseline-preflight-'),
    );
    const agent = elloAgent();
    const createAgent = vi.fn();
    const removeContainer = vi.fn().mockResolvedValue(undefined);
    const services = servicesFor(attemptRoot, createAgent, removeContainer);
    const run = RunManifestSchema.parse({
      schema: 'ello.benchmark.run.v2',
      attemptId: 'a'.repeat(24),
      attempt: 1,
      job: {
        schema: 'ello.benchmark.job.v2',
        jobId: 'b'.repeat(16),
        taskId: 'task-a',
        agentId: agent.id,
        agentConfigHash: sha256(stableJson(agent)),
        replicate: 1,
      },
      configHash: 'c'.repeat(64),
      status: 'planned',
      phase: 'planned',
      attemptRoot,
      workspace: path.join(attemptRoot, 'workspace'),
      agentStateRoot: path.join(attemptRoot, 'agent-state'),
    });

    const result = await runAttempt(
      {
        manifest: run,
        runRoot: attemptRoot,
        agent,
        provenance: {
          scope: 'ello',
          elloRevision: '1'.repeat(40),
          sourceTree: '2'.repeat(40),
          lockfileSha256: '3'.repeat(64),
          nodeVersion: '24.0.0',
          pnpmVersion: '11.0.0',
          platform: 'linux',
          architecture: 'x64',
          packages: { agent: '1', tui: '1', bench: '1' },
        },
        taskFiles: taskFiles(attemptRoot),
        pullPolicy: 'never',
        cleanupPolicy: 'always',
      },
      services,
    );

    expect(result).toMatchObject({
      status: 'invalid_infrastructure',
      phase: 'verifier-baseline-preflight',
      baselinePreflightExitCode: 1,
      failure: {
        kind: 'verifier',
        message: 'baseline-unhealthy: clean baseline exited 1.',
      },
    });
    expect(createAgent).not.toHaveBeenCalled();
    expect(removeContainer).toHaveBeenCalledOnce();
    expect(services.workspace.cleanup).toHaveBeenCalledWith({
      attemptRoot,
      workspace: path.join(attemptRoot, 'workspace'),
    });
  });

  it('retains an unhealthy attempt workspace with on-success cleanup', async () => {
    const attemptRoot = await mkdtemp(
      path.join(tmpdir(), 'ello-bench-baseline-preflight-'),
    );
    const agent = elloAgent();
    const services = servicesFor(
      attemptRoot,
      vi.fn(),
      vi.fn().mockResolvedValue(undefined),
    );

    const result = await runAttempt(
      runRequest(attemptRoot, agent, 'on-success'),
      services,
    );

    expect(result.status).toBe('invalid_infrastructure');
    expect(services.workspace.cleanup).not.toHaveBeenCalled();
  });
});

describe('run attempt workspace cleanup policy', () => {
  it.each([
    { cleanupPolicy: 'always' as const, shouldCleanup: true },
    { cleanupPolicy: 'on-success' as const, shouldCleanup: true },
    { cleanupPolicy: 'never' as const, shouldCleanup: false },
  ])(
    '$cleanupPolicy cleanup: $shouldCleanup after a completed attempt',
    async ({ cleanupPolicy, shouldCleanup }) => {
      const attemptRoot = await mkdtemp(
        path.join(tmpdir(), 'ello-bench-completed-attempt-'),
      );
      const agent = elloAgent();
      const removeContainer = vi.fn().mockResolvedValue(undefined);
      const services = servicesFor(
        attemptRoot,
        completedAgentFactory(attemptRoot),
        removeContainer,
        'completed',
      );

      const result = await runAttempt(
        runRequest(attemptRoot, agent, cleanupPolicy),
        services,
      );

      expect(result).toMatchObject({
        status: 'completed',
        phase: 'completed',
        outcome: 'passed',
      });
      if (shouldCleanup) {
        expect(services.workspace.cleanup).toHaveBeenCalledWith({
          attemptRoot,
          workspace: path.join(attemptRoot, 'workspace'),
        });
      } else {
        expect(services.workspace.cleanup).not.toHaveBeenCalled();
      }
      expect(removeContainer).toHaveBeenCalledTimes(
        cleanupPolicy === 'never' ? 0 : 1,
      );
    },
  );
});

function servicesFor(
  attemptRoot: string,
  createAgent: ReturnType<typeof vi.fn>,
  removeContainer: ReturnType<typeof vi.fn>,
  scenario: 'baseline-unhealthy' | 'completed' = 'baseline-unhealthy',
): RunAttemptServices {
  const patchSha256 = '9'.repeat(64);
  const transition = async (
    manifest: Parameters<RunAttemptServices['runs']['transition']>[0],
    status: Parameters<RunAttemptServices['runs']['transition']>[1],
    fields: Parameters<RunAttemptServices['runs']['transition']>[2],
  ) => RunManifestSchema.parse({ ...manifest, ...fields, status });
  return {
    agents: { create: createAgent },
    artifacts: fsArtifactStore,
    clock: { now: () => new Date('2026-08-03T00:00:00.000Z') },
    patches: {
      capture:
        scenario === 'completed'
          ? vi.fn().mockResolvedValue({
              path: path.join(attemptRoot, 'raw', 'model.patch'),
              sha256: patchSha256,
              bytes: 1,
              changedFiles: ['source.ts'],
              baselineTree: 'd'.repeat(40),
            })
          : vi.fn(),
    },
    paths: {
      resolve: () => ({
        rawRoot: path.join(attemptRoot, 'raw'),
        rawAgentRoot: path.join(attemptRoot, 'raw', 'agent'),
        taskInstruction: path.join(
          attemptRoot,
          'raw',
          'task',
          'instruction.md',
        ),
        resolvedTask: path.join(attemptRoot, 'raw', 'task', 'resolved.json'),
        harnessRoot: path.join(attemptRoot, 'raw', 'harness'),
        baselineHarnessRoot: path.join(
          attemptRoot,
          'raw',
          'baseline-preflight',
        ),
        phaseTimings: path.join(attemptRoot, 'raw', 'phase-timings.json'),
        patch: path.join(attemptRoot, 'raw', 'model.patch'),
        gitStatus: path.join(attemptRoot, 'raw', 'git-status.txt'),
        gitCacheRoot: path.join(attemptRoot, 'cache'),
        dockerPreflight: path.join(attemptRoot, 'raw', 'docker.json'),
        networkPolicy: path.join(attemptRoot, 'raw', 'network.json'),
        failureLog: (name) => path.join(attemptRoot, 'raw', name),
      }),
    },
    phases: {
      create: () => ({
        path: path.join(attemptRoot, 'raw', 'phase-timings.json'),
        run: (_phase, operation) => operation(),
      }),
    },
    runs: {
      transition,
      update: (manifest, fields) =>
        Promise.resolve(RunManifestSchema.parse({ ...manifest, ...fields })),
      invalidate: (manifest, failure) =>
        transition(manifest, 'invalid_infrastructure', {
          phase: failure.phase,
          completedAt: '2026-08-03T00:00:00.000Z',
          failure,
        }),
    },
    verifier: {
      preflight: () =>
        Promise.resolve({
          process: {
            path: path.join(attemptRoot, 'raw', 'baseline-process.json'),
            sha256: '4'.repeat(64),
          },
          exitCode: scenario === 'completed' ? 0 : 1,
          imageId: 'sha256:image',
        }),
      run:
        scenario === 'completed'
          ? vi.fn().mockResolvedValue({
              schema: 'ello.benchmark.harness.v1',
              taskId: 'task-a',
              status: 'passed',
              reward: 1,
              verifierProcess: {
                path: path.join(attemptRoot, 'raw', 'verifier-process.json'),
                sha256: '8'.repeat(64),
              },
              verifierRuntime: 'docker',
              verifierImage: 'example/image:fixed',
              verifierImageId: 'sha256:image',
              modelPatchSha256: patchSha256,
              appliedPatchSha256: patchSha256,
              verifierCapturedPatchSha256: patchSha256,
              baselineTestExitCode: 0,
              newTestsExitCode: 0,
              hiddenPatchChangedFiles: [],
              patchConflictFiles: [],
              modelPatchChangedFiles: ['source.ts'],
              verifierAssertions: [],
              lastAgentVerificationRound: null,
              reportPath: path.join(
                attemptRoot,
                'raw',
                'harness',
                'report.json',
              ),
              completedAt: '2026-08-03T00:00:00.000Z',
            })
          : vi.fn(),
    },
    workspace: {
      prepare: () =>
        Promise.resolve({
          workspace: path.join(attemptRoot, 'workspace'),
          baselineTree: 'd'.repeat(40),
          initialGitStatus: '',
          container: {
            name: 'agent-container',
            workspace: '/app',
            storagePolicy: {
              enforcement: 'workspace-and-writable-layer-watchdog',
              accounting: [
                'bind-workspace-apparent-bytes',
                'container-size-rw',
              ],
              limitBytes: 1,
              intervalMs: 1,
            },
            exec: vi.fn(),
            spawn: vi.fn(),
            copyIn: vi.fn(),
            copyOut: vi.fn(),
            assertStorageLimit: vi.fn(),
            remove: removeContainer,
          },
          containerUser: '1000:1000',
          imageId: 'sha256:image',
          network: 'bridge',
        }),
      cleanup: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function runRequest(
  attemptRoot: string,
  agent: ReturnType<typeof elloAgent>,
  cleanupPolicy: 'always' | 'on-success' | 'never',
) {
  return {
    manifest: plannedRun(attemptRoot, agent),
    runRoot: attemptRoot,
    agent,
    provenance: {
      scope: 'ello' as const,
      elloRevision: '1'.repeat(40),
      sourceTree: '2'.repeat(40),
      lockfileSha256: '3'.repeat(64),
      nodeVersion: '24.0.0',
      pnpmVersion: '11.0.0',
      platform: 'linux',
      architecture: 'x64',
      packages: { agent: '1', tui: '1', bench: '1' },
    },
    taskFiles: taskFiles(attemptRoot),
    pullPolicy: 'never' as const,
    cleanupPolicy,
  };
}

function plannedRun(attemptRoot: string, agent: ReturnType<typeof elloAgent>) {
  return RunManifestSchema.parse({
    schema: 'ello.benchmark.run.v2',
    attemptId: 'a'.repeat(24),
    attempt: 1,
    job: {
      schema: 'ello.benchmark.job.v2',
      jobId: 'b'.repeat(16),
      taskId: 'task-a',
      agentId: agent.id,
      agentConfigHash: sha256(stableJson(agent)),
      replicate: 1,
    },
    configHash: 'c'.repeat(64),
    status: 'planned',
    phase: 'planned',
    attemptRoot,
    workspace: path.join(attemptRoot, 'workspace'),
    agentStateRoot: path.join(attemptRoot, 'agent-state'),
  });
}

function completedAgentFactory(attemptRoot: string) {
  const process = {
    command: 'agent',
    args: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1,
    stdoutBytes: 0,
    stderrBytes: 0,
  };
  return vi.fn().mockReturnValue({
    prepare: vi.fn().mockResolvedValue({
      run: vi.fn().mockResolvedValue({
        process,
        startedAt: '2026-08-03T00:00:00.000Z',
        completedAt: '2026-08-03T00:00:00.000Z',
        artifact: {
          path: path.join(attemptRoot, 'raw', 'agent-process.json'),
          sha256: '7'.repeat(64),
        },
        stdoutPath: path.join(attemptRoot, 'raw', 'agent', 'stdout.log'),
        stderrPath: path.join(attemptRoot, 'raw', 'agent', 'stderr.log'),
      }),
      close: vi.fn().mockResolvedValue(undefined),
      normalize: vi.fn().mockRejectedValue(new Error('fixture degradation')),
    }),
  });
}

function taskFiles(root: string) {
  return {
    benchmark: 'deep-swe' as const,
    task: {
      schema: 'ello.benchmark.resolved-task.v2' as const,
      benchmark: 'deep-swe' as const,
      taskId: 'task-a',
      extId: 'external',
      displayTitle: 'Task',
      displayDescription: 'Description',
      originalTitle: 'Original',
      category: 'feature_request',
      language: 'go' as const,
      repositoryUrl: 'https://github.com/example/project',
      baseCommitHash: 'd'.repeat(40),
      agentTimeoutMs: 1_000,
      verifierTimeoutMs: 1_000,
      environment: {
        image: 'example/image:fixed',
        allowInternet: false,
        buildTimeoutMs: 1_000,
        cpus: 1,
        memoryMb: 1_024,
        storageMb: 1_024,
      },
      instructionSha256: 'e'.repeat(64),
      verifierScriptSha256: 'f'.repeat(64),
      verifierPatchSha256: '0'.repeat(64),
    },
    taskRoot: root,
    instruction: 'Implement task.',
    instructionPath: path.join(root, 'instruction.md'),
    verifierScriptPath: path.join(root, 'test.sh'),
    verifierPatchPath: path.join(root, 'test.patch'),
  };
}

function elloAgent() {
  return {
    id: 'ello',
    displayName: 'Ello',
    kind: 'ello' as const,
    models: {
      primary: {
        protocol: 'openai' as const,
        endpoint: 'responses' as const,
        apiModel: 'model',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEnv: 'API_KEY',
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        reasoningEffort: 'high' as const,
      },
    },
    primaryModel: 'primary',
    auxiliaryModel: 'primary',
    features: {
      subagents: false,
    },
  };
}
