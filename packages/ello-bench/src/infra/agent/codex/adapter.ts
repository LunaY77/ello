import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  AgentRuntimeProvenanceSchema,
  type CodexAgentSpec,
} from '../../../domain/contract/index.js';
import { auditExternalTools } from '../../../domain/evidence/routing-audit.js';
import { sha256, stableJson } from '../../../domain/hash.js';
import {
  type AgentAdapter,
  type AgentProcessExecution,
  type AgentRunContext,
  type PreparedAgent,
} from '../../../ports/agent.js';
import { writeJsonAtomic } from '../../io.js';
import { AgentAdapterError } from '../error.js';
import {
  validateJsonLines,
  writeAgentProcessArtifact,
  writeNormalizedEvidence,
} from '../evidence.js';
import { concreteEnvironment } from '../external.js';

import { createCodexInvocation } from './invocation.js';
import { parseCodexEvidence } from './parser.js';

export function createCodexAdapter(agent: CodexAgentSpec): AgentAdapter {
  return {
    async prepare(context: AgentRunContext): Promise<PreparedAgent> {
      requireMatchingAgent(agent, context);
      if (sha256(stableJson(agent)) !== context.agentConfigHash) {
        throw new AgentAdapterError(
          'agent_setup',
          `Codex Agent config hash mismatch for ${agent.id}.`,
        );
      }
      await mkdir(path.join(context.rawAgentRoot, 'adapter'), {
        recursive: true,
      });
      const invocation = await createCodexInvocation(agent, context);
      return {
        async run(): Promise<AgentProcessExecution> {
          const stdoutPath = path.join(context.rawAgentRoot, 'stdout.jsonl');
          const stderrPath = path.join(context.rawAgentRoot, 'stderr.log');
          const startedAt = new Date().toISOString();
          const execution = await context.container.exec(
            [invocation.command, ...invocation.args],
            {
              cwd: invocation.cwd,
              env: concreteEnvironment(invocation.env),
              input: invocation.input,
              timeoutMs: context.taskFiles.task.agentTimeoutMs,
              killGraceMs: 5_000,
              stdoutPath,
              stderrPath,
            },
          );
          const completedAt = new Date().toISOString();
          await validateJsonLines(stdoutPath);
          const processArtifact = await writeAgentProcessArtifact({
            rawAgentRoot: context.rawAgentRoot,
            execution: {
              process: execution.process,
              startedAt,
              completedAt,
              stdoutPath,
              stderrPath,
            },
            invocationPath: invocation.invocationPath,
          });
          return {
            process: execution.process,
            startedAt,
            completedAt,
            artifact: processArtifact.reference,
            stdoutPath,
            stderrPath,
          };
        },
        async close(): Promise<void> {},
        async normalize(execution: AgentProcessExecution) {
          const roundsPath = path.join(context.rawAgentRoot, 'rounds.jsonl');
          const normalized = await parseCodexEvidence({
            agent,
            execution,
            roundsPath,
          });
          const audit = auditExternalTools({
            tools: normalized.tools,
            parserCoverage: normalized.evidence.parserCoverage,
            workspace: context.workspace,
          });
          const runtime = AgentRuntimeProvenanceSchema.parse({
            schema: 'ello.benchmark.agent-runtime.v1',
            agentId: agent.id,
            displayName: agent.displayName,
            agentConfigHash: context.agentConfigHash,
            adapterContractVersion: '1',
            expectedModel: agent.model,
            observedModel: normalized.evidence.observedModel,
            configSha256: sha256(stableJson(agent)),
            kind: agent.kind,
            executablePath: invocation.command,
            expectedVersion: agent.binary.expectedVersion,
            observedVersion: invocation.observedVersion,
            executableSha256: invocation.executableSha256,
            runtimeBoundaryInstructionSha256: invocation.runtimeBoundarySha256,
            reasoningEffort: agent.reasoningEffort,
            baseUrl: agent.connection.baseUrl,
            apiKeyEnv: agent.connection.apiKeyEnv,
          });
          await writeJsonAtomic(
            path.join(context.rawAgentRoot, 'identity.json'),
            runtime,
          );
          const artifacts = await writeNormalizedEvidence({
            rawAgentRoot: context.rawAgentRoot,
            evidence: normalized.evidence,
            audit,
          });
          return {
            runtime,
            evidence: normalized.evidence,
            rounds: normalized.rounds,
            evidenceArtifact: artifacts.evidenceArtifact,
            toolAudit: audit,
            toolAuditArtifact: artifacts.toolAuditArtifact,
            providerFailure: normalized.evidence.providerFailure,
            providerFailureMessage: normalized.providerFailureMessage,
          };
        },
      };
    },
  };
}

function requireMatchingAgent(
  agent: CodexAgentSpec,
  context: AgentRunContext,
): void {
  if (context.agent.kind !== 'codex' || context.agent.id !== agent.id) {
    throw new AgentAdapterError(
      'agent_setup',
      `Codex adapter received Agent ${context.agent.id}.`,
    );
  }
}
