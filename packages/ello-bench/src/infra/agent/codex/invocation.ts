import path from 'node:path';

import type { CodexAgentSpec } from '../../../domain/contract/index.js';
import type { AgentRunContext } from '../../../ports/agent.js';
import { writeJsonAtomic } from '../../io.js';
import {
  externalProcessEnvironment,
  inspectExternalRuntime,
  prepareCodexHome,
  requiredEnvironment,
} from '../external.js';
import {
  composeExternalAgentPrompt,
  createRuntimeBoundaryInstruction,
  runtimeBoundarySha256,
} from '../runtime-boundary.js';

const BENCHMARK_PROVIDER_ID = 'ello_benchmark';

export interface CodexInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly input: string;
  readonly invocationPath: string;
  readonly runtimeBoundarySha256: string;
  readonly executableSha256: string;
  readonly observedVersion: string;
}

export async function createCodexInvocation(
  agent: CodexAgentSpec,
  context: AgentRunContext,
): Promise<CodexInvocation> {
  const runtime = await inspectExternalRuntime(agent);
  const isolated = await prepareCodexHome({
    agentStateRoot: context.agentStateRoot,
  });
  const apiKey = requiredEnvironment(agent.connection.apiKeyEnv);
  const runtimeBoundary = createRuntimeBoundaryInstruction(context);
  const boundarySha256 = runtimeBoundarySha256(runtimeBoundary);
  const provider = codexProviderOverride(agent);
  const args = [
    'exec',
    '--json',
    '--color',
    'never',
    '--strict-config',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '-C',
    context.workspace,
    '-m',
    agent.model,
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    `model_provider=${tomlString(BENCHMARK_PROVIDER_ID)}`,
    '-c',
    `model_reasoning_effort=${tomlString(agent.reasoningEffort)}`,
    '-c',
    'web_search="disabled"',
    '-c',
    'mcp_servers={}',
    '-c',
    `model_providers.${BENCHMARK_PROVIDER_ID}=${provider}`,
    '-',
  ] as const;
  const env = externalProcessEnvironment({
    ...(agent.environment ?? {}),
    HOME: isolated.home,
    USERPROFILE: isolated.home,
    CODEX_HOME: isolated.codexHome,
    [agent.connection.apiKeyEnv]: apiKey,
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
      CODEX_HOME: isolated.codexHome,
      API_KEY_ENV: agent.connection.apiKeyEnv,
    },
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    modelProvider: {
      id: BENCHMARK_PROVIDER_ID,
      baseUrl: agent.connection.baseUrl,
      apiKeyEnv: agent.connection.apiKeyEnv,
      httpHeaders: agent.connection.httpHeaders ?? {},
      wireApi: 'responses',
    },
    mcpServers: {},
    webSearch: 'disabled',
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
    input: composeExternalAgentPrompt({
      boundary: runtimeBoundary,
      instruction: context.taskFiles.instruction,
    }),
    invocationPath,
    runtimeBoundarySha256: boundarySha256,
    executableSha256: runtime.executableSha256,
    observedVersion: runtime.observedVersion,
  };
}

function codexProviderOverride(agent: CodexAgentSpec): string {
  const fields = [
    `name=${tomlString('Ello benchmark provider')}`,
    `base_url=${tomlString(agent.connection.baseUrl)}`,
    `env_key=${tomlString(agent.connection.apiKeyEnv)}`,
    'wire_api="responses"',
    'requires_openai_auth=false',
    'supports_websockets=false',
  ];
  if (agent.connection.httpHeaders !== undefined) {
    const headers = Object.entries(agent.connection.httpHeaders)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${tomlString(name)}=${tomlString(value)}`)
      .join(',');
    fields.push(`http_headers={${headers}}`);
  }
  return `{${fields.join(',')}}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
