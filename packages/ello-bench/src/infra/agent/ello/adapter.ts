import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  AgentRuntimeProvenanceSchema,
  NormalizedAgentEvidenceSchema,
  type ElloAgentSpec,
} from '../../../domain/contract/index.js';
import { auditElloTools } from '../../../domain/evidence/routing-audit.js';
import { combineThreadRounds } from '../../../domain/evidence/thread-evidence.js';
import { sha256, stableJson } from '../../../domain/hash.js';
import {
  type AgentAdapter,
  type AgentProcessExecution,
  type AgentRunContext,
  type PreparedAgent,
} from '../../../ports/agent.js';
import { writeBenchmarkAgentConfig } from '../../config-writer.js';
import { runElloCli } from '../../ello-cli.js';
import {
  startBenchmarkServerProcess,
  type BenchmarkServerProcess,
} from '../../ello-server.js';
import { validateEventEvidence } from '../../event-evidence.js';
import { writeJsonAtomic, writeJsonLines } from '../../io.js';
import { normalizeEventCapture } from '../../rounds.js';
import {
  CONTAINER_AGENT_STATE_ROOT,
  CONTAINER_RAW_AGENT_ROOT,
} from '../container-paths.js';
import { AgentAdapterError } from '../error.js';
import {
  aggregateUsage,
  fileEvidence,
  summarizeTools,
  terminalStopReason,
  validateJsonLines,
  writeAgentProcessArtifact,
  writeNormalizedEvidence,
} from '../evidence.js';

import {
  buildElloProviderRecoveryInstruction,
  findElloProviderRecoveryTarget,
} from './provider-recovery.js';
import { effectiveToolProvenance } from './tool-provenance.js';

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
        runtimeHome: CONTAINER_AGENT_STATE_ROOT,
        workspace: context.workspace,
        agentWorkspace: context.container.workspace,
        agent,
        snapshotPath: configSnapshotPath,
      });
      const invocationPath = path.join(context.rawAgentRoot, 'invocation.json');
      const runtimeEnv = elloContainerEnvironment(agent);
      await writeJsonAtomic(invocationPath, {
        schema: 'ello.benchmark.agent-invocation.v1',
        agentId: agent.id,
        kind: agent.kind,
        primaryModel: agent.primaryModel,
        auxiliaryModel: agent.auxiliaryModel,
        workspace: context.container.workspace,
        executionRuntime: 'docker',
        containerName: context.container.name,
        containerWorkspace: context.container.workspace,
        instructionSha256: context.taskFiles.task.instructionSha256,
        configSnapshotPath,
      });
      const serverBase = {
        container: context.container,
        workspace: context.container.workspace,
        elloHome: CONTAINER_AGENT_STATE_ROOT,
        socketPath: `/tmp/ello-bench-${context.attemptId}.sock`,
        rawRoot: `${CONTAINER_RAW_AGENT_ROOT}/adapter`,
        stdoutPath: path.join(context.rawAgentRoot, 'server.stdout.log'),
        stderrPath: path.join(context.rawAgentRoot, 'server.stderr.log'),
        env: runtimeEnv,
      } as const;
      let server: BenchmarkServerProcess | undefined =
        await startBenchmarkServerProcess(serverBase);
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
          const initialProcess = await runElloCli({
            container: context.container,
            endpoint: server.endpoint,
            workspace: context.container.workspace,
            elloHome: CONTAINER_AGENT_STATE_ROOT,
            instruction: context.taskFiles.instruction,
            timeoutMs: context.taskFiles.task.agentTimeoutMs,
            stdoutPath,
            stderrPath,
            env: runtimeEnv,
          });
          await validateJsonLines(stdoutPath);
          const recovery = await recoverProviderFailure({
            endpoint: server.endpoint,
            container: context.container,
            workspace: context.container.workspace,
            elloHome: CONTAINER_AGENT_STATE_ROOT,
            env: runtimeEnv,
            timeoutMs: context.taskFiles.task.agentTimeoutMs,
            rawAgentRoot: context.rawAgentRoot,
            eventRoot: path.join(context.rawAgentRoot, 'adapter'),
            stdoutPath,
            stderrPath,
            initialProcess,
            originalInstruction: context.taskFiles.instruction,
          });
          const process = recovery?.process ?? initialProcess;
          const completedAt = new Date().toISOString();
          if (recovery !== null) await validateJsonLines(stdoutPath);
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
          const captures = await validateEventEvidence(adapterRoot);
          const mainRoundsPath = path.join(
            context.rawAgentRoot,
            `rounds-${captures.main.threadId}.jsonl`,
          );
          const main = await normalizeEventCapture({
            eventLogPath: captures.main.eventLogPath,
            roundsPath: mainRoundsPath,
            allowIncomplete: execution.process.timedOut,
          });
          const subagents = await Promise.all(
            captures.subagents.map(async (capture) => {
              const threadRoundsPath = path.join(
                context.rawAgentRoot,
                `rounds-${capture.threadId}.jsonl`,
              );
              return {
                capture,
                roundsPath: threadRoundsPath,
                normalized: await normalizeEventCapture({
                  eventLogPath: capture.eventLogPath,
                  roundsPath: threadRoundsPath,
                  allowIncomplete: execution.process.timedOut,
                }),
              };
            }),
          );
          const combinedRounds = combineThreadRounds([
            ...main.rounds,
            ...subagents.flatMap((thread) => thread.normalized.rounds),
          ]);
          const combinedTools = [
            ...main.tools,
            ...subagents.flatMap((thread) => thread.normalized.tools),
          ];
          const roundsPath = path.join(context.rawAgentRoot, 'rounds.jsonl');
          await writeJsonLines(roundsPath, combinedRounds);
          const elloRounds = requireElloRounds(combinedRounds);
          validateElloRounds(agent, elloRounds);
          const firstRound = requireElloRounds(main.rounds)[0];
          if (firstRound === undefined)
            throw new Error('Ello observed model is missing.');
          const observedModel = firstRound.apiModel;
          const effectiveTools = effectiveToolProvenance(
            main.toolsetFingerprints,
          );
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
              : main.runFailureMessage !== null
                ? 'failed'
                : 'completed',
            providerFailure: main.providerFailure,
            parserCoverage: 'complete',
            terminalStopReason:
              main.runFailureMessage ?? terminalStopReason(main.rounds),
            unknownFields: [],
            rawSource: await fileEvidence(captures.main.eventLogPath),
            rounds: await fileEvidence(roundsPath),
            roundCount: combinedRounds.length,
            usage: aggregateUsage(combinedRounds),
            tools: summarizeTools(combinedRounds),
            effectiveTools,
            threads: [
              {
                threadId: captures.main.threadId,
                kind: 'main',
                rawSource: await fileEvidence(captures.main.eventLogPath),
                rounds: await fileEvidence(mainRoundsPath),
                roundCount: main.rounds.length,
                usage: main.usage,
              },
              ...(await Promise.all(
                subagents.map(async (thread) => ({
                  threadId: thread.capture.threadId,
                  kind: 'subagent' as const,
                  rawSource: await fileEvidence(thread.capture.eventLogPath),
                  rounds: await fileEvidence(thread.roundsPath),
                  roundCount: thread.normalized.rounds.length,
                  usage: thread.normalized.usage,
                })),
              )),
            ],
            threadUsage: {
              main: main.usage,
              subagents: aggregateUsage(
                subagents.flatMap((thread) => thread.normalized.rounds),
              ),
              combined: aggregateUsage(combinedRounds),
            },
          });
          const audit = auditElloTools(combinedTools);
          const runtime = AgentRuntimeProvenanceSchema.parse({
            schema: 'ello.benchmark.agent-runtime.v1',
            agentId: agent.id,
            displayName: agent.displayName,
            agentConfigHash: context.agentConfigHash,
            adapterContractVersion: '2',
            expectedModel: primaryModel.apiModel,
            observedModel,
            configSha256: sha256(stableJson(agent)),
            kind: agent.kind,
            primaryModel: agent.primaryModel,
            auxiliaryModel: agent.auxiliaryModel,
            promptMode: agent.promptMode,
            enabledTools: effectiveTools.enabled,
            toolsetFingerprint: effectiveTools.toolsetFingerprint,
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
            rounds: combinedRounds,
            evidenceArtifact: artifacts.evidenceArtifact,
            toolAudit: audit,
            toolAuditArtifact: artifacts.toolAuditArtifact,
            providerFailure: main.providerFailure,
            providerFailureMessage: main.providerFailureMessage,
          };
        },
      };
    },
  };
}

async function recoverProviderFailure(options: {
  readonly container: AgentRunContext['container'];
  readonly endpoint: string;
  readonly workspace: '/app';
  readonly elloHome: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly rawAgentRoot: string;
  readonly eventRoot: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly initialProcess: import('../../../domain/contract/index.js').ProcessResult;
  readonly originalInstruction: string;
}): Promise<{
  readonly process: import('../../../domain/contract/index.js').ProcessResult;
} | null> {
  if (
    options.initialProcess.timedOut ||
    options.initialProcess.exitCode === 0
  ) {
    return null;
  }
  const remainingTimeoutMs = Math.floor(
    options.timeoutMs - options.initialProcess.durationMs,
  );
  if (remainingTimeoutMs <= 0) return null;
  const target = await findElloProviderRecoveryTarget({
    stdoutPath: options.stdoutPath,
    eventRoot: options.eventRoot,
  });
  if (target === null) return null;

  const recoveryRoot = path.join(options.rawAgentRoot, 'provider-recovery');
  const initialStdoutPath = path.join(recoveryRoot, 'initial.stdout.jsonl');
  const initialStderrPath = path.join(recoveryRoot, 'initial.stderr.log');
  await mkdir(recoveryRoot, { recursive: true });
  await Promise.all([
    copyFile(options.stdoutPath, initialStdoutPath),
    copyFile(options.stderrPath, initialStderrPath),
  ]);
  const recoveryStartedAt = new Date().toISOString();
  const recoveredProcess = await runElloCli({
    container: options.container,
    endpoint: options.endpoint,
    workspace: options.workspace,
    elloHome: options.elloHome,
    instruction: buildElloProviderRecoveryInstruction(
      options.originalInstruction,
    ),
    threadId: target.threadId,
    timeoutMs: remainingTimeoutMs,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    env: options.env,
  });
  const recoveryCompletedAt = new Date().toISOString();
  const process = {
    ...recoveredProcess,
    durationMs: options.initialProcess.durationMs + recoveredProcess.durationMs,
  };
  await writeJsonAtomic(
    path.join(options.rawAgentRoot, 'provider-recovery.json'),
    {
      schema: 'ello.benchmark.provider-recovery.v1',
      threadId: target.threadId,
      eventLogPath: target.eventLogPath,
      remainingTimeoutMs,
      initial: {
        process: options.initialProcess,
        stdoutPath: initialStdoutPath,
        stderrPath: initialStderrPath,
      },
      recovery: {
        startedAt: recoveryStartedAt,
        completedAt: recoveryCompletedAt,
        process: recoveredProcess,
        stdoutPath: options.stdoutPath,
        stderrPath: options.stderrPath,
      },
    },
  );
  return { process };
}

function elloContainerEnvironment(
  agent: ElloAgentSpec,
): Readonly<Record<string, string>> {
  const credentials = Object.fromEntries(
    [
      ...new Set(Object.values(agent.models).map((model) => model.apiKeyEnv)),
    ].map((name) => [name, requiredEnvironment(name)]),
  );
  const inherited = Object.fromEntries(
    [
      'LANG',
      'LC_ALL',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
    ].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return { ...inherited, ...credentials };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new AgentAdapterError(
      'agent_setup',
      `Missing required environment variable: ${name}.`,
    );
  }
  return value;
}

function validateElloRounds(
  agent: ElloAgentSpec,
  rounds: readonly Extract<
    import('../../../domain/contract/index.js').BenchmarkRound,
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
  rounds: readonly import('../../../domain/contract/index.js').BenchmarkRound[],
): readonly Extract<
  import('../../../domain/contract/index.js').BenchmarkRound,
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
