import type {
  AgentSpec,
  InfrastructureFailure,
  PatchArtifact,
  RunManifest,
  RunProvenance,
} from '../domain/contract/index.js';

import type { AgentAdapterFactory } from './agent.js';
import type { ArtifactStore } from './artifact-store.js';
import type { Clock } from './clock.js';
import type { ContainerHandle, PullPolicy } from './container.js';
import type { ResolvedTaskFiles } from './corpus.js';
import type { VerifierRuntime } from './verifier.js';

export interface AttemptPaths {
  readonly rawRoot: string;
  readonly rawAgentRoot: string;
  readonly taskInstruction: string;
  readonly resolvedTask: string;
  readonly harnessRoot: string;
  readonly phaseTimings: string;
  readonly patch: string;
  readonly gitStatus: string;
  readonly gitCacheRoot: string;
  readonly dockerPreflight: string;
  readonly networkPolicy: string;
  failureLog(name: string): string;
}

export interface AttemptPathResolver {
  resolve(manifest: RunManifest, runRoot: string): AttemptPaths;
}

export interface PreparedWorkspace {
  readonly workspace: string;
  readonly baselineTree: string;
  readonly initialGitStatus: string;
  readonly container: ContainerHandle;
  readonly containerUser: string;
  readonly imageId: string;
  readonly network: 'none' | 'bridge';
}

export interface WorkspaceRuntime {
  prepare(options: {
    readonly attemptId: string;
    readonly workspace: string;
    readonly taskFiles: ResolvedTaskFiles;
    readonly pullPolicy: PullPolicy;
  }): Promise<PreparedWorkspace>;
}

export interface PatchCapture {
  capture(options: {
    readonly workspace: string;
    readonly baselineTree: string;
    readonly patchPath: string;
    readonly statusPath: string;
  }): Promise<PatchArtifact>;
}

export interface PhaseTimer {
  readonly path: string;
  run<T>(phase: string, operation: () => Promise<T>): Promise<T>;
}

export interface PhaseTimerFactory {
  create(path: string): PhaseTimer;
}

export interface RunStateStore {
  transition(
    manifest: RunManifest,
    nextStatus: RunManifest['status'],
    fields: Partial<
      Omit<RunManifest, 'schema' | 'attemptId' | 'job' | 'configHash'>
    >,
  ): Promise<RunManifest>;
  update(
    manifest: RunManifest,
    fields: Partial<
      Omit<RunManifest, 'schema' | 'attemptId' | 'job' | 'configHash'>
    >,
  ): Promise<RunManifest>;
  invalidate(
    manifest: RunManifest,
    failure: InfrastructureFailure,
  ): Promise<RunManifest>;
}

export interface RunAttemptRequest {
  readonly manifest: RunManifest;
  readonly runRoot: string;
  readonly agent: AgentSpec;
  readonly provenance: RunProvenance;
  readonly taskFiles: ResolvedTaskFiles;
  readonly pullPolicy: PullPolicy;
  readonly cleanupPolicy: 'always' | 'on-success' | 'never';
}

export interface RunAttemptServices {
  readonly agents: AgentAdapterFactory;
  readonly artifacts: ArtifactStore;
  readonly clock: Clock;
  readonly patches: PatchCapture;
  readonly paths: AttemptPathResolver;
  readonly phases: PhaseTimerFactory;
  readonly runs: RunStateStore;
  readonly verifier: VerifierRuntime;
  readonly workspace: WorkspaceRuntime;
}
