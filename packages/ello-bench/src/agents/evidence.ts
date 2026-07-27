import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AgentProcessArtifactSchema,
  ArtifactReferenceSchema,
  FileEvidenceSchema,
  NormalizedAgentEvidenceSchema,
  ToolAuditSchema,
  type AgentProcessArtifact,
  type ArtifactReference,
  type BenchmarkRound,
  type CompleteUsageEvidence,
  type FileEvidence,
  type NormalizedAgentEvidence,
  type NormalizedToolCall,
  type ToolAudit,
  type UsageEvidence,
} from '../contracts.js';
import { sha256 } from '../hash.js';
import { writeJsonAtomic } from '../io.js';

import { AgentAdapterError, type AgentProcessExecution } from './adapter.js';

export async function validateJsonLines(filePath: string): Promise<void> {
  parseJsonLines(await readFile(filePath, 'utf8'), filePath);
}

export function parseJsonLines(source: string, label: string): unknown[] {
  const records: unknown[] = [];
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new AgentAdapterError(
        'agent_evidence',
        `Invalid Agent JSONL in ${label} at line ${index + 1}.`,
        { cause: error },
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AgentAdapterError(
        'agent_evidence',
        `Agent JSONL in ${label} line ${index + 1} is not an object.`,
      );
    }
    records.push(parsed);
  }
  return records;
}

export async function fileEvidence(filePath: string): Promise<FileEvidence> {
  const content = await readFile(filePath);
  return FileEvidenceSchema.parse({
    path: filePath,
    sha256: sha256(content),
    bytes: content.byteLength,
  });
}

export async function writeAgentProcessArtifact(options: {
  readonly rawAgentRoot: string;
  readonly execution: Omit<AgentProcessExecution, 'artifact'>;
  readonly invocationPath: string;
}): Promise<{
  readonly artifact: AgentProcessArtifact;
  readonly reference: ArtifactReference;
}> {
  const artifactPath = path.join(options.rawAgentRoot, 'process.json');
  const artifact = AgentProcessArtifactSchema.parse({
    schema: 'ello.benchmark.agent-process.v1',
    startedAt: options.execution.startedAt,
    completedAt: options.execution.completedAt,
    process: options.execution.process,
    invocation: await fileEvidence(options.invocationPath),
    stdout: await fileEvidence(options.execution.stdoutPath),
    stderr: await fileEvidence(options.execution.stderrPath),
  });
  await writeJsonAtomic(artifactPath, artifact);
  return {
    artifact,
    reference: await artifactReference(artifactPath),
  };
}

export async function writeNormalizedEvidence(options: {
  readonly rawAgentRoot: string;
  readonly evidence: NormalizedAgentEvidence;
  readonly audit: ToolAudit;
}): Promise<{
  readonly evidenceArtifact: ArtifactReference;
  readonly toolAuditArtifact: ArtifactReference;
}> {
  const evidencePath = path.join(options.rawAgentRoot, 'evidence.json');
  const auditPath = path.join(options.rawAgentRoot, 'tool-audit.json');
  await writeJsonAtomic(
    evidencePath,
    NormalizedAgentEvidenceSchema.parse(options.evidence),
  );
  await writeJsonAtomic(auditPath, ToolAuditSchema.parse(options.audit));
  return {
    evidenceArtifact: await artifactReference(evidencePath),
    toolAuditArtifact: await artifactReference(auditPath),
  };
}

export async function artifactReference(
  filePath: string,
): Promise<ArtifactReference> {
  const content = await readFile(filePath);
  return ArtifactReferenceSchema.parse({
    path: filePath,
    sha256: sha256(content),
  });
}

export function aggregateUsage(
  rounds: readonly BenchmarkRound[],
): UsageEvidence {
  const unavailable = rounds.find((round) => round.usage.status === 'unavailable');
  if (unavailable?.usage.status === 'unavailable') {
    return {
      status: 'unavailable',
      reason: `Round ${unavailable.round}: ${unavailable.usage.reason}`,
    };
  }
  return rounds.reduce<CompleteUsageEvidence>(
    (total, round) => {
      if (round.usage.status !== 'complete') {
        throw new Error(`Round ${round.round} usage is not complete.`);
      }
      return {
        status: 'complete',
        requests: total.requests + round.usage.requests,
        inputTokens: total.inputTokens + round.usage.inputTokens,
        outputTokens: total.outputTokens + round.usage.outputTokens,
        cacheReadTokens: addReportedTokens(
          total.cacheReadTokens,
          round.usage.cacheReadTokens,
        ),
        cacheWriteTokens: addReportedTokens(
          total.cacheWriteTokens,
          round.usage.cacheWriteTokens,
        ),
        reasoningTokens: addReportedTokens(
          total.reasoningTokens,
          round.usage.reasoningTokens,
        ),
        toolCalls: total.toolCalls + round.usage.toolCalls,
      };
    },
    {
      status: 'complete',
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      toolCalls: 0,
    },
  );
}

function addReportedTokens(
  total: number | null,
  value: number | null,
): number | null {
  return total === null || value === null ? null : total + value;
}

/**
 * Stop reason for the run as a whole, taken from the last round that reported
 * one. Agents that never report a finish reason yield null.
 */
export function terminalStopReason(
  rounds: readonly BenchmarkRound[],
): string | null {
  return (
    [...rounds]
      .reverse()
      .map((round) => round.finishReason)
      .find((reason): reason is string => reason !== undefined) ?? null
  );
}

export function summarizeTools(
  rounds: readonly BenchmarkRound[],
): NormalizedAgentEvidence['tools'] {
  const tools = rounds.flatMap((round) => round.toolCalls);
  const firstStartedAt = rounds
    .map((round) => round.startedAt)
    .find((value): value is string => value !== null);
  const firstMutation = tools.find(
    (tool) => tool.mutating && tool.startedAt !== null,
  );
  return {
    total: tools.length,
    failed: tools.filter((tool) => tool.status === 'failed').length,
    read: countCategory(tools, 'read'),
    search: countCategory(tools, 'search'),
    edit: countCategory(tools, 'edit'),
    shell: countCategory(tools, 'shell'),
    other: countCategory(tools, 'other'),
    timeToFirstMutationMs:
      firstStartedAt === undefined ||
      firstMutation === undefined ||
      firstMutation.startedAt === null
        ? null
        : elapsedMs(firstStartedAt, firstMutation.startedAt),
  };
}

function countCategory(
  tools: readonly NormalizedToolCall[],
  category: NormalizedToolCall['category'],
): number {
  return tools.filter((tool) => tool.category === category).length;
}

function elapsedMs(startedAt: string, completedAt: string): number {
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  if (elapsed < 0) {
    throw new Error(
      `Negative Agent evidence duration: ${startedAt} to ${completedAt}.`,
    );
  }
  return elapsed;
}
