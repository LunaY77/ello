import path from 'node:path';

import { containerShellFlag, containerShellMode } from '../container-shell.js';
import { sha256 } from '../hash.js';

import type { AgentRunContext } from './adapter.js';

export const RUNTIME_BOUNDARY_VERSION = '1';

export function createRuntimeBoundaryInstruction(options: {
  readonly containerName: string;
  readonly containerWorkspace: '/app';
  readonly taskFiles: AgentRunContext['taskFiles'];
}): string {
  const commandPrefix = dockerCommandPrefix(options);
  return [
    `Benchmark runtime boundary version ${RUNTIME_BOUNDARY_VERSION}.`,
    'Repository files are in the current workspace.',
    'Do not inspect benchmark tests, verifier inputs, reference solutions, or task corpus source files.',
    'Do not use web search, HTTP fetch, browser, MCP, or any network tool.',
    'Host file tools may read and edit only paths inside the current workspace.',
    'Every repository shell command, including reads, searches, Git commands, and tests, must run in the assigned task container.',
    `Use exactly this shell command prefix: ${commandPrefix}`,
    `The repository working directory inside the container is ${options.containerWorkspace}.`,
    'Do not run repository shell commands on the host.',
  ].join('\n');
}

export function dockerCommandPrefix(options: {
  readonly containerName: string;
  readonly containerWorkspace: '/app';
  readonly taskFiles: AgentRunContext['taskFiles'];
}): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(options.containerName)) {
    throw new Error(
      `Invalid benchmark container name: ${options.containerName}.`,
    );
  }
  if (path.posix.normalize(options.containerWorkspace) !== '/app') {
    throw new Error(
      `External Agent container workspace must be /app: ${options.containerWorkspace}.`,
    );
  }
  const shellFlag = containerShellFlag(
    containerShellMode(options.taskFiles.task.benchmark),
  );
  return `docker exec -w /app ${options.containerName} bash ${shellFlag} '<command>'`;
}

export function composeExternalAgentPrompt(options: {
  readonly boundary: string;
  readonly instruction: string;
}): string {
  return [
    '<benchmark-runtime-boundary>',
    options.boundary,
    '</benchmark-runtime-boundary>',
    '<task-instruction>',
    options.instruction,
    '</task-instruction>',
  ].join('\n');
}

export function runtimeBoundarySha256(boundary: string): string {
  return sha256(Buffer.from(boundary, 'utf8'));
}
