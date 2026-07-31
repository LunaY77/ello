import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { stringify } from 'yaml';

import type { ElloAgentSpec } from '../domain/contract/index.js';

import { writeJsonAtomic } from './io.js';

export interface BenchmarkConfigFiles {
  readonly elloHome: string;
  readonly configPath: string;
  readonly snapshotPath: string;
}

export async function writeBenchmarkAgentConfig(options: {
  readonly elloHome: string;
  readonly workspace: string;
  readonly agentWorkspace?: string;
  readonly agent: ElloAgentSpec;
  readonly snapshotPath: string;
}): Promise<BenchmarkConfigFiles> {
  const elloHome = path.resolve(options.elloHome);
  const workspace = path.resolve(options.workspace);
  const agentWorkspace = options.agentWorkspace ?? workspace;
  const projectStateRoot = path.join(workspace, '.ello');
  if (await exists(projectStateRoot)) {
    throw new Error(
      `Benchmark workspace must not contain Ello project state: ${projectStateRoot}`,
    );
  }
  const models = Object.fromEntries(
    Object.entries(options.agent.models).map(([name, model]) => [
      name,
      {
        protocol: model.protocol,
        ...(model.protocol === 'anthropic'
          ? { auth_scheme: model.authScheme }
          : { endpoint: model.endpoint }),
        api_model: model.apiModel,
        base_url: model.baseUrl,
        api_key_env: model.apiKeyEnv,
        ...(model.httpHeaders === undefined
          ? {}
          : { http_headers: model.httpHeaders }),
        context_window: model.contextWindow,
        max_output_tokens: model.maxOutputTokens,
        reasoning_effort: model.reasoningEffort,
      },
    ]),
  );
  const config = {
    default_agent: 'build',
    models,
    primary_model: options.agent.primaryModel,
    auxiliary_model: options.agent.auxiliaryModel,
    cwd: agentWorkspace,
    allowed_paths: [agentWorkspace],
    session_dir: path.join(elloHome, 'sessions'),
    initial_mode: 'bypass',
    bypass_enabled: true,
    title_generation: false,
    subagents: {
      enabled: options.agent.features.subagents,
      cwd_policy: 'allowed_paths',
    },
    tools: {
      disabled: [],
      need_approval: [],
      routing_enabled: false,
      search: { result_limit: 6, max_result_bytes: 24_000 },
    },
    context: {
      instructions: {
        global: [],
        project: ['AGENTS.md', '.ello/ELLO.md', '.ello/instructions.md'],
        extra: [],
        nearby: true,
      },
      memory: {
        enabled: false,
        private_dir: path.join(elloHome, 'memory', 'private'),
        team_dir: path.posix.join(agentWorkspace, '.ello', 'memory', 'team'),
        extraction: { enabled: false, recent_messages: 40, max_attempts: 2 },
      },
    },
  };
  assertCredentialFree(config);
  await mkdir(elloHome, { recursive: true });
  const configPath = path.join(elloHome, 'config.yaml');
  await writeFile(configPath, stringify(config), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await writeFile(path.join(elloHome, 'mcp.json'), '{\n  "servers": {}\n}\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  const snapshotPath = path.resolve(options.snapshotPath);
  await writeJsonAtomic(snapshotPath, config);
  return { elloHome, configPath, snapshotPath };
}

function assertCredentialFree(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertCredentialFree(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /^(api_key|authorization|headers|options|password|secret)$/iu.test(key)
    ) {
      throw new Error(
        `Benchmark config snapshot contains credential field ${key}.`,
      );
    }
    assertCredentialFree(child);
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}
