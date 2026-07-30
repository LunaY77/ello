import type {
  AgentRuntimeProvenance,
  AgentSpec,
  ArtifactReference,
  BenchmarkRound,
  NormalizedAgentEvidence,
  ProcessResult,
  ToolAudit,
} from '../domain/contract/index.js';

import type { ContainerHandle } from './container.js';
import type { ResolvedTaskFiles } from './corpus.js';

export interface AgentRunContext {
  readonly attemptId: string;
  readonly agent: AgentSpec;
  readonly agentConfigHash: string;
  readonly agentStateRoot: string;
  readonly workspace: string;
  readonly rawAgentRoot: string;
  readonly taskFiles: ResolvedTaskFiles;
  readonly container: ContainerHandle;
}

export interface AgentProcessExecution {
  readonly process: ProcessResult;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly artifact: ArtifactReference;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface NormalizedAgentExecution {
  readonly runtime: AgentRuntimeProvenance;
  readonly evidence: NormalizedAgentEvidence;
  readonly rounds: readonly BenchmarkRound[];
  readonly evidenceArtifact: ArtifactReference;
  readonly toolAudit: ToolAudit;
  readonly toolAuditArtifact: ArtifactReference;
  readonly providerFailure: boolean;
  readonly providerFailureMessage: string | null;
}

export interface PreparedAgent {
  run(): Promise<AgentProcessExecution>;
  close(): Promise<void>;
  normalize(
    execution: AgentProcessExecution,
  ): Promise<NormalizedAgentExecution>;
}

export interface AgentAdapter {
  prepare(context: AgentRunContext): Promise<PreparedAgent>;
}

export interface AgentAdapterFactory {
  create(agent: AgentSpec): AgentAdapter;
}

export type AgentFailureKind =
  | 'agent_setup'
  | 'agent_process'
  | 'agent_evidence'
  | 'agent_environment';

export interface AgentAdapterFailure extends Error {
  readonly agentFailure: true;
  readonly kind: AgentFailureKind;
}
