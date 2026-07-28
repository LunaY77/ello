import path from 'node:path';

import { writeBenchmarkAgentConfig } from '../../config-writer.js';
import { containerShellMode } from '../../container-shell.js';
import {
  AgentRuntimeProvenanceSchema,
  NormalizedAgentEvidenceSchema,
  type ElloAgentSpec,
} from '../../contracts.js';
import { runElloCli } from '../../ello-cli.js';
import {
  startBenchmarkServerProcess,
  type BenchmarkServerProcess,
} from '../../ello-server.js';
import { validateEventEvidence } from '../../event-evidence.js';
import { sha256, stableJson } from '../../hash.js';
import { writeJsonAtomic } from '../../io.js';
import { normalizeEventCapture } from '../../rounds.js';
import {
  type AgentAdapter,
  AgentAdapterError,
  type AgentProcessExecution,
  type AgentRunContext,
  type PreparedAgent,
} from '../adapter.js';
import {
  fileEvidence,
  terminalStopReason,
  validateJsonLines,
  writeAgentProcessArtifact,
  writeNormalizedEvidence,
} from '../evidence.js';
import { auditElloTools } from '../routing-audit.js';

export function createElloAdapter(agent: ElloAgentSpec): AgentAdapter {
  return {
    async prepare(context: AgentRunContext): Promise<PreparedAgent> {
      if (context.agent.kind !== 'ello' || context.agent.id !== agent.id) {
        throw new AgentAdapterError(
          'agent_setup',
          `Ello adapter received Agent ${context.agent.id}.`,
        );
      }
      if (sha256(stableJson(agent)) !== context.agentConfigHash) {
        throw new AgentAdapterError(
          'agent_setup',
          `Ello Agent config hash mismatch for ${agent.id}.`,
        );
      }
      requireCredential(agent);
      const configSnapshotPath = path.join(
        context.rawAgentRoot,
        'config-snapshot.json',
      );
      await writeBenchmarkAgentConfig({
        elloHome: context.agentStateRoot,
        workspace: context.workspace,
        agent,
        snapshotPath: configSnapshotPath,
      });
      const invocationPath = path.join(context.rawAgentRoot, 'invocation.json');
      await writeJsonAtomic(invocationPath, {
        schema: 'ello.benchmark.agent-invocation.v1',
        agentId: agent.id,
        kind: agent.kind,
        primaryModel: agent.primaryModel,
        auxiliaryModel: agent.auxiliaryModel,
        workspace: context.workspace,
        executionRuntime: context.runtime,
        ...(context.runtime === 'docker'
          ? {
              containerName: context.containerName,
              containerWorkspace: context.containerWorkspace,
            }
          : {}),
        instructionSha256: context.taskFiles.task.instructionSha256,
        configSnapshotPath,
      });
      const serverBase = {
        workspace: context.workspace,
        elloHome: context.agentStateRoot,
        socketPath: path.join(
          process.env.TMPDIR ?? '/tmp',
          `ello-bench-${context.attemptId}.sock`,
        ),
        rawRoot: path.join(context.rawAgentRoot, 'adapter'),
        stdoutPath: path.join(context.rawAgentRoot, 'server.stdout.log'),
        stderrPath: path.join(context.rawAgentRoot, 'server.stderr.log'),
      } as const;
      let server: BenchmarkServerProcess | undefined =
        await startBenchmarkServerProcess(
          context.runtime === 'docker'
            ? {
                ...serverBase,
                runtime: context.runtime,
                containerName: context.containerName,
                containerWorkspace: context.containerWorkspace,
                shellMode: containerShellMode(context.taskFiles.task.benchmark),
              }
            : { ...serverBase, runtime: context.runtime },
        );
      return {
        async run(): Promise<AgentProcessExecution> {
          if (server === undefined) {
            throw new AgentAdapterError(
              'agent_process',
              'Ello App Server is not running.',
            );
          }
          const stdoutPath = path.join(context.rawAgentRoot, 'stdout.jsonl');
          const stderrPath = path.join(context.rawAgentRoot, 'stderr.log');
          const startedAt = new Date().toISOString();
          const process = await runElloCli({
            endpoint: server.endpoint,
            workspace: context.workspace,
            elloHome: context.agentStateRoot,
            instruction: context.taskFiles.instruction,
            timeoutMs: context.taskFiles.task.agentTimeoutMs,
            stdoutPath,
            stderrPath,
          });
          const completedAt = new Date().toISOString();
          await validateJsonLines(stdoutPath);
          const processArtifact = await writeAgentProcessArtifact({
            rawAgentRoot: context.rawAgentRoot,
            execution: {
              process,
              startedAt,
              completedAt,
              stdoutPath,
              stderrPath,
            },
            invocationPath,
          });
          return {
            process,
            startedAt,
            completedAt,
            artifact: processArtifact.reference,
            stdoutPath,
            stderrPath,
          };
        },
        async close(): Promise<void> {
          if (server === undefined) return;
          const active = server;
          server = undefined;
          await active.close();
        },
        async normalize(execution: AgentProcessExecution) {
          const adapterRoot = path.join(context.rawAgentRoot, 'adapter');
          const capture = await validateEventEvidence(adapterRoot);
          const roundsPath = path.join(context.rawAgentRoot, 'rounds.jsonl');
          const normalized = await normalizeEventCapture({
            eventLogPath: capture.eventLogPath,
            roundsPath,
            allowIncomplete: execution.process.timedOut,
          });
          const elloRounds = requireElloRounds(normalized.rounds);
          validateElloRounds(agent, elloRounds);
          const firstRound = elloRounds[0];
          if (firstRound === undefined)
            throw new Error('Ello observed model is missing.');
          const observedModel = firstRound.apiModel;
          const primaryModel = agent.models[agent.primaryModel];
          if (primaryModel === undefined) {
            throw new Error(
              `Ello primary model is missing: ${agent.primaryModel}.`,
            );
          }
          const evidence = NormalizedAgentEvidenceSchema.parse({
            schema: 'ello.benchmark.agent-evidence.v1',
            agentId: agent.id,
            kind: agent.kind,
            observedModel,
            terminalStatus: execution.process.timedOut
              ? 'timed_out'
              : normalized.providerFailure
                ? 'failed'
                : 'completed',
            providerFailure: normalized.providerFailure,
            parserCoverage: 'complete',
            terminalStopReason: terminalStopReason(normalized.rounds),
            unknownFields: [],
            rawSource: await fileEvidence(capture.eventLogPath),
            rounds: await fileEvidence(roundsPath),
            roundCount: normalized.rounds.length,
            usage: normalized.usage,
            tools: summarizeElloTools(normalized.tools, normalized.rounds),
          });
          const audit = auditElloTools(normalized.tools);
          const runtime = AgentRuntimeProvenanceSchema.parse({
            schema: 'ello.benchmark.agent-runtime.v1',
            agentId: agent.id,
            displayName: agent.displayName,
            agentConfigHash: context.agentConfigHash,
            adapterContractVersion: '1',
            expectedModel: primaryModel.apiModel,
            observedModel,
            configSha256: sha256(stableJson(agent)),
            kind: agent.kind,
            primaryModel: agent.primaryModel,
            auxiliaryModel: agent.auxiliaryModel,
          });
          await writeJsonAtomic(
            path.join(context.rawAgentRoot, 'identity.json'),
            runtime,
          );
          const artifacts = await writeNormalizedEvidence({
            rawAgentRoot: context.rawAgentRoot,
            evidence,
            audit,
          });
          return {
            runtime,
            evidence,
            evidenceArtifact: artifacts.evidenceArtifact,
            toolAudit: audit,
            toolAuditArtifact: artifacts.toolAuditArtifact,
            providerFailure: normalized.providerFailure,
            providerFailureMessage: providerFailureMessage(normalized.rounds),
          };
        },
      };
    },
  };
}

function providerFailureMessage(
  rounds: readonly import('../../contracts.js').BenchmarkRound[],
): string | null {
  const failed = rounds.filter((round) => round.status === 'failed');
  if (failed.length === 0) return null;
  const messages = failed.map((round) => round.error);
  if (messages.some((message) => message === undefined)) {
    throw new Error('Ello failed model round is missing its provider error.');
  }
  return `Ello provider error: ${messages.join(' | ')}`;
}

function summarizeElloTools(
  tools: readonly import('../../contracts.js').NormalizedToolCall[],
  rounds: readonly import('../../contracts.js').BenchmarkRound[],
) {
  const firstStartedAt = rounds[0]?.startedAt;
  const firstMutation = tools.find(
    (tool) => tool.mutating && tool.startedAt !== null,
  );
  return {
    total: tools.length,
    failed: tools.filter((tool) => tool.status === 'failed').length,
    read: tools.filter((tool) => tool.category === 'read').length,
    search: tools.filter((tool) => tool.category === 'search').length,
    edit: tools.filter((tool) => tool.category === 'edit').length,
    shell: tools.filter((tool) => tool.category === 'shell').length,
    other: tools.filter((tool) => tool.category === 'other').length,
    timeToFirstMutationMs:
      firstStartedAt === undefined ||
      firstStartedAt === null ||
      firstMutation?.startedAt === null ||
      firstMutation === undefined
        ? null
        : Date.parse(firstMutation.startedAt) - Date.parse(firstStartedAt),
  };
}

function validateElloRounds(
  agent: ElloAgentSpec,
  rounds: readonly Extract<
    import('../../contracts.js').BenchmarkRound,
    { readonly modelSelector: 'primary_model' | 'auxiliary_model' }
  >[],
): void {
  for (const round of rounds) {
    const configuredModel =
      round.modelSelector === 'primary_model'
        ? agent.primaryModel
        : agent.auxiliaryModel;
    if (round.configuredModel !== configuredModel) {
      throw new AgentAdapterError(
        'agent_evidence',
        `Ello round ${round.round} configured model mismatch: ${round.configuredModel}.`,
      );
    }
    const model = agent.models[configuredModel];
    if (model === undefined) {
      throw new AgentAdapterError(
        'agent_evidence',
        `Unknown configured model: ${configuredModel}.`,
      );
    }
    if (
      round.agentName === '' ||
      round.protocol !== model.protocol ||
      round.apiModel !== model.apiModel
    ) {
      throw new AgentAdapterError(
        'agent_evidence',
        `Ello round ${round.round} model identity does not match ${configuredModel}.`,
      );
    }
  }
}

function requireElloRounds(
  rounds: readonly import('../../contracts.js').BenchmarkRound[],
): readonly Extract<
  import('../../contracts.js').BenchmarkRound,
  { readonly modelSelector: 'primary_model' | 'auxiliary_model' }
>[] {
  return rounds.map((round) => {
    if (!('modelSelector' in round)) {
      throw new AgentAdapterError(
        'agent_evidence',
        'Ello round has no model identity.',
      );
    }
    return round;
  });
}

function requireCredential(agent: ElloAgentSpec): void {
  for (const model of Object.values(agent.models)) {
    const value = process.env[model.apiKeyEnv];
    if (value === undefined || value === '') {
      throw new AgentAdapterError(
        'agent_setup',
        `Missing model credential: ${model.apiKeyEnv}.`,
      );
    }
  }
}
