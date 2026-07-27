import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ResolvedTaskSchema,
  type DeepSweTaskDeclaration,
  type ResolvedTask,
} from './contracts.js';
import { sha256 } from './hash.js';
import { parseTaskToml } from './task-toml.js';

export interface LoadedDeepSweTask {
  readonly benchmark: 'deep-swe';
  readonly task: Extract<ResolvedTask, { benchmark: 'deep-swe' }>;
  readonly taskRoot: string;
  readonly instruction: string;
  readonly instructionPath: string;
  readonly verifierScriptPath: string;
  readonly verifierPatchPath: string;
}

export async function loadDeepSweTask(
  corpusRoot: string,
  declaration: DeepSweTaskDeclaration,
): Promise<LoadedDeepSweTask> {
  const taskRoot = path.join(path.resolve(corpusRoot), declaration.taskId);
  const taskTomlPath = path.join(taskRoot, 'task.toml');
  const instructionPath = path.join(taskRoot, 'instruction.md');
  const verifierScriptPath = path.join(taskRoot, 'tests', 'test.sh');
  const verifierPatchPath = path.join(taskRoot, 'tests', 'test.patch');
  const [tomlSource, instruction, verifierScript, verifierPatch] =
    await Promise.all([
      readFile(taskTomlPath, 'utf8'),
      readFile(instructionPath, 'utf8'),
      readFile(verifierScriptPath, 'utf8'),
      readFile(verifierPatchPath, 'utf8'),
    ]);
  if (instruction.trim() === '') {
    throw new Error(`Task instruction is empty: ${declaration.taskId}`);
  }
  const parsed = parseTaskToml(tomlSource);
  if (parsed.metadata.task_id !== declaration.taskId) {
    throw new Error(
      `Task id mismatch: expected ${declaration.taskId}, received ${parsed.metadata.task_id}.`,
    );
  }
  if (parsed.metadata.language !== declaration.language) {
    throw new Error(
      `Task language mismatch for ${declaration.taskId}: expected ${declaration.language}, received ${parsed.metadata.language}.`,
    );
  }
  const task = ResolvedTaskSchema.parse({
    schema: 'ello.benchmark.resolved-task.v2',
    benchmark: 'deep-swe',
    taskId: parsed.metadata.task_id,
    extId: parsed.metadata.ext_id,
    displayTitle: parsed.metadata.display_title,
    displayDescription: parsed.metadata.display_description,
    originalTitle: parsed.metadata.original_title,
    category: parsed.metadata.category,
    language: parsed.metadata.language,
    repositoryUrl: parsed.metadata.repository_url,
    baseCommitHash: parsed.metadata.base_commit_hash,
    agentTimeoutMs: secondsToMilliseconds(parsed.agent.timeout_sec, 'agent'),
    verifierTimeoutMs: secondsToMilliseconds(
      parsed.verifier.timeout_sec,
      'verifier',
    ),
    environment: {
      image: parsed.environment.docker_image,
      allowInternet: parsed.environment.allow_internet,
      buildTimeoutMs: secondsToMilliseconds(
        parsed.environment.build_timeout_sec,
        'environment build',
      ),
      cpus: parsed.environment.cpus,
      memoryMb: parsed.environment.memory_mb,
      storageMb: parsed.environment.storage_mb,
    },
    instructionSha256: sha256(instruction),
    verifierScriptSha256: sha256(verifierScript),
    verifierPatchSha256: sha256(verifierPatch),
  });
  if (task.benchmark !== 'deep-swe') {
    throw new Error(`Resolved unexpected task benchmark: ${task.benchmark}.`);
  }
  return {
    benchmark: 'deep-swe',
    task,
    taskRoot,
    instruction,
    instructionPath,
    verifierScriptPath,
    verifierPatchPath,
  };
}

function secondsToMilliseconds(seconds: number, label: string): number {
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(`Invalid ${label} timeout: ${seconds}.`);
  }
  return milliseconds;
}
