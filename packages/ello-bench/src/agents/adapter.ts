import type {
  AgentRuntimeProvenance,
  AgentSpec,
  ArtifactReference,
  NormalizedAgentEvidence,
  ProcessResult,
  ToolAudit,
} from '../contracts.js';
import type { ResolvedTaskFiles } from '../task-corpus.js';

interface AgentRunContextBase {
  readonly attemptId: string;
  readonly agent: AgentSpec;
  readonly agentConfigHash: string;
  readonly agentStateRoot: string;
  readonly workspace: string;
  readonly rawAgentRoot: string;
  readonly taskFiles: ResolvedTaskFiles;
}

export interface DockerAgentRunContext extends AgentRunContextBase {
  readonly runtime: 'docker';
  readonly containerName: string;
  readonly containerWorkspace: '/app';
}

export interface LocalAgentRunContext extends AgentRunContextBase {
  readonly runtime: 'local';
}

export type AgentRunContext = DockerAgentRunContext | LocalAgentRunContext;

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

export class AgentAdapterError extends Error {
  readonly kind:
    | 'agent_setup'
    | 'agent_process'
    | 'agent_evidence'
    | 'agent_environment';

  constructor(
    kind: AgentAdapterError['kind'],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentAdapterError';
    this.kind = kind;
  }
}
