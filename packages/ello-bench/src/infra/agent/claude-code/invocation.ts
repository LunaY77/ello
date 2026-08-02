import path from 'node:path';

import type { ClaudeCodeAgentSpec } from '../../../domain/contract/index.js';
import type { AgentRunContext } from '../../../ports/agent.js';
import { writeJsonAtomic } from '../../io.js';
import {
  externalProcessEnvironment,
  inspectExternalRuntime,
  prepareClaudeHome,
  requiredEnvironment,
} from '../external.js';
import {
  createRuntimeBoundaryInstruction,
  runtimeBoundarySha256,
} from '../runtime-boundary.js';

import { requireClaudeCodeBaseUrl } from './base-url.js';

export interface ClaudeCodeInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly input: string;
  readonly invocationPath: string;
  readonly runtimeBoundary: string;
  readonly runtimeBoundarySha256: string;
  readonly executableSha256: string;
  readonly observedVersion: string;
  readonly reasoningEffort: NonNullable<ClaudeCodeAgentSpec['reasoningEffort']>;
}

export async function createClaudeCodeInvocation(
  agent: ClaudeCodeAgentSpec,
  context: AgentRunContext,
): Promise<ClaudeCodeInvocation> {
  const reasoningEffort = agent.reasoningEffort;
  if (reasoningEffort === undefined) {
    throw new Error('Claude Code reasoning effort is required for execution.');
  }
  const baseUrl = requireClaudeCodeBaseUrl(agent.connection.baseUrl);
  const runtime = await inspectExternalRuntime(agent);
  const isolated = await prepareClaudeHome({
    agentStateRoot: context.agentStateRoot,
  });
  const apiKey = requiredEnvironment(agent.connection.apiKeyEnv);
  const runtimeBoundary = createRuntimeBoundaryInstruction(context);
  const boundarySha256 = runtimeBoundarySha256(runtimeBoundary);
  const emptyMcpConfig = JSON.stringify({ mcpServers: {} });
  const tools = 'Bash,Edit,Read,Write,Glob,Grep';
  const args = [
    '--print',
    '--model',
    agent.model,
    '--effort',
    reasoningEffort,
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--safe-mode',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    emptyMcpConfig,
    '--disable-slash-commands',
    '--no-chrome',
    '--tools',
    tools,
    '--append-system-prompt',
    runtimeBoundary,
  ] as const;
  const customHeaders = agent.connection.httpHeaders;
  const env = externalProcessEnvironment({
    HOME: isolated.home,
    USERPROFILE: isolated.home,
    CLAUDE_CONFIG_DIR: isolated.configDirectory,
    CLAUDE_CODE_SAFE_MODE: '1',
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ...(customHeaders === undefined
      ? {}
      : {
          ANTHROPIC_CUSTOM_HEADERS: Object.entries(customHeaders)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n'),
        }),
    ...(agent.environment ?? {}),
  });
  const invocationPath = path.join(context.rawAgentRoot, 'invocation.json');
  await writeJsonAtomic(invocationPath, {
    schema: 'ello.benchmark.agent-invocation.v1',
    agentId: agent.id,
    kind: agent.kind,
    command: runtime.executablePath,
    args,
    cwd: context.workspace,
    environment: {
      HOME: isolated.home,
      USERPROFILE: isolated.home,
      CLAUDE_CONFIG_DIR: isolated.configDirectory,
      CLAUDE_CODE_SAFE_MODE: '1',
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN_ENV: agent.connection.apiKeyEnv,
    },
    model: agent.model,
    reasoningEffort,
    tools: tools.split(','),
    mcpConfig: JSON.parse(emptyMcpConfig) as unknown,
    controlRuntime: 'host',
    executionRuntime: 'docker',
    containerName: context.container.name,
    containerWorkspace: context.container.workspace,
    instructionSha256: context.taskFiles.task.instructionSha256,
    runtimeBoundary,
    runtimeBoundarySha256: boundarySha256,
  });
  return {
    command: runtime.executablePath,
    args,
    cwd: context.workspace,
    env,
    input: context.taskFiles.instruction,
    invocationPath,
    runtimeBoundary,
    runtimeBoundarySha256: boundarySha256,
    executableSha256: runtime.executableSha256,
    observedVersion: runtime.observedVersion,
    reasoningEffort,
  };
}
