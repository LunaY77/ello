import { sha256 } from '../../domain/hash.js';
import type { AgentRunContext } from '../../ports/agent.js';

export const RUNTIME_BOUNDARY_VERSION = '1';

export function createRuntimeBoundaryInstruction(
  options: AgentRunContext,
): string {
  return [
    `Benchmark runtime boundary version ${RUNTIME_BOUNDARY_VERSION}.`,
    'The Agent process and repository are inside the assigned task container.',
    'Do not inspect benchmark tests, verifier inputs, reference solutions, or task corpus source files.',
    'Do not use web search, HTTP fetch, browser, MCP, or any network tool.',
    'File and shell tools may access only the current workspace.',
    `The repository working directory is ${options.container.workspace}.`,
    'Run repository commands directly; do not invoke Docker or another container.',
  ].join('\n');
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
