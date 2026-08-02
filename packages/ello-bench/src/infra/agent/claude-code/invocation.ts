import path from 'node:path';

import type { ClaudeCodeAgentSpec } from '../../../domain/contract/index.js';
import type { AgentRunContext } from '../../../ports/agent.js';
import { writeJsonAtomic } from '../../io.js';
import {
  containerExternalProcessEnvironment,
  externalAgentContainerExecutable,
  inspectExternalRuntime,
  prepareClaudeHome,
  requiredEnvironment,
} from '../external.js';
import { requireClaudeCodeBaseUrl } from './base-url.js';
import { CONTAINER_AGENT_STATE_ROOT } from '../container-paths.js';

export interface ClaudeCodeInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly input: string;
  readonly invocationPath: string;
  readonly executableSha256: string;
  readonly configuredExecutablePath: string;
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
  const runtime = await inspectExternalRuntime(agent, context.container);
  await prepareClaudeHome({
    agentStateRoot: context.agentStateRoot,
  });
  const apiKey = requiredEnvironment(agent.connection.apiKeyEnv);
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
  ] as const;
  const customHeaders = agent.connection.httpHeaders;
  const containerHome = `${CONTAINER_AGENT_STATE_ROOT}/home`;
  const containerConfigDirectory = `${containerHome}/.claude`;
  const env = containerExternalProcessEnvironment({
    HOME: containerHome,
    USERPROFILE: containerHome,
    CLAUDE_CONFIG_DIR: containerConfigDirectory,
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
    command: externalAgentContainerExecutable(agent),
    args,
    cwd: context.container.workspace,
    environment: {
      HOME: containerHome,
      USERPROFILE: containerHome,
      CLAUDE_CONFIG_DIR: containerConfigDirectory,
      CLAUDE_CODE_SAFE_MODE: '1',
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN_ENV: agent.connection.apiKeyEnv,
    },
    model: agent.model,
    reasoningEffort,
    tools: tools.split(','),
    mcpConfig: JSON.parse(emptyMcpConfig) as unknown,
    controlRuntime: 'container',
    executionRuntime: 'docker',
    containerName: context.container.name,
    containerWorkspace: context.container.workspace,
    instructionSha256: context.taskFiles.task.instructionSha256,
  });
  return {
    command: externalAgentContainerExecutable(agent),
    args,
    cwd: context.container.workspace,
    env,
    input: context.taskFiles.instruction,
    invocationPath,
    executableSha256: runtime.executableSha256,
    configuredExecutablePath: runtime.executablePath,
    observedVersion: runtime.observedVersion,
    reasoningEffort,
  };
}
