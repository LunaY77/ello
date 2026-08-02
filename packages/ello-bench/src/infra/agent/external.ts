import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentSpec } from '../../domain/contract/index.js';
import { sha256 } from '../../domain/hash.js';
import type { ContainerHandle, ContainerMount } from '../../ports/container.js';

import { AgentAdapterError } from './error.js';

export type ExternalAgentSpec = Exclude<AgentSpec, { readonly kind: 'ello' }>;

export interface ExternalRuntimeInspection {
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly observedVersion: string;
}

const CONTAINER_EXTERNAL_RUNTIME_ROOT = '/opt/ello-agent';

export async function externalAgentRuntimeMount(
  agent: ExternalAgentSpec,
): Promise<ContainerMount> {
  const executablePath = await realpath(
    path.resolve(requiredEnvironment(agent.binary.pathEnv)),
  );
  const host =
    agent.kind === 'codex'
      ? await resolveCodexNativeExecutable(executablePath)
      : executablePath;
  return {
    host,
    container: externalAgentContainerExecutable(agent),
    readOnly: true,
  };
}

export function externalAgentContainerExecutable(
  agent: ExternalAgentSpec,
): string {
  return `${CONTAINER_EXTERNAL_RUNTIME_ROOT}/${agent.kind}`;
}

export async function inspectExternalRuntime(
  agent: ExternalAgentSpec,
  container: ContainerHandle,
): Promise<ExternalRuntimeInspection> {
  const executableValue = requiredEnvironment(agent.binary.pathEnv);
  const executablePath = path.resolve(executableValue);
  const metadata = await stat(executablePath).catch((error: unknown) => {
    throw new AgentAdapterError(
      'agent_setup',
      `Cannot inspect Agent executable: ${executablePath}.`,
      { cause: error },
    );
  });
  if (!metadata.isFile()) {
    throw new AgentAdapterError(
      'agent_setup',
      `Agent executable is not a regular file: ${executablePath}.`,
    );
  }
  const executableSha256 = sha256(await readFile(executablePath));
  if (executableSha256 !== agent.binary.sha256) {
    throw new AgentAdapterError(
      'agent_setup',
      `Agent executable SHA-256 mismatch for ${agent.id}: ${executableSha256}.`,
    );
  }
  const versionExecution = await container.exec(
    [externalAgentContainerExecutable(agent), '--version'],
    {
      cwd: container.workspace,
      env: containerExternalProcessEnvironment({}),
      timeoutMs: 15_000,
      killGraceMs: 2_000,
      maxOutputBytes: 1024 * 1024,
    },
  );
  const stdout = requiredCaptured(versionExecution.stdout, 'stdout').trim();
  const stderr = requiredCaptured(versionExecution.stderr, 'stderr').trim();
  if (
    versionExecution.process.exitCode !== 0 ||
    versionExecution.process.timedOut
  ) {
    throw new AgentAdapterError(
      'agent_setup',
      `Agent version command failed for ${agent.id}: ${stderr}.`,
    );
  }
  const observedVersion = firstLine(stdout === '' ? stderr : stdout);
  const expectedVersion = expectedVersionOutput(agent);
  if (observedVersion !== expectedVersion) {
    throw new AgentAdapterError(
      'agent_setup',
      `Agent version mismatch for ${agent.id}: expected ${expectedVersion}, observed ${observedVersion}.`,
    );
  }
  return {
    executablePath,
    executableSha256,
    observedVersion,
  };
}

export async function prepareClaudeHome(options: {
  readonly agentStateRoot: string;
}): Promise<{ readonly home: string; readonly configDirectory: string }> {
  const home = path.join(options.agentStateRoot, 'home');
  const configDirectory = path.join(home, '.claude');
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  return { home, configDirectory };
}

export async function prepareCodexHome(options: {
  readonly agentStateRoot: string;
}): Promise<{ readonly home: string; readonly codexHome: string }> {
  const home = path.join(options.agentStateRoot, 'home');
  const codexHome = path.join(options.agentStateRoot, 'codex-home');
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(codexHome, { recursive: true, mode: 0o700 }),
  ]);
  return { home, codexHome };
}

export function externalProcessEnvironment(
  overrides: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const names = [
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ] as const;
  const inherited = Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return { ...inherited, ...overrides };
}

export function containerExternalProcessEnvironment(
  overrides: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const names = [
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ] as const;
  return {
    ...Object.fromEntries(
      names.flatMap((name) => {
        const value = process.env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    ),
    ...overrides,
  };
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new AgentAdapterError(
      'agent_setup',
      `Missing required environment variable: ${name}.`,
    );
  }
  return value;
}

function expectedVersionOutput(agent: ExternalAgentSpec): string {
  switch (agent.kind) {
    case 'claude-code':
      return `${agent.binary.expectedVersion} (Claude Code)`;
    case 'codex':
      return `codex-cli ${agent.binary.expectedVersion}`;
  }
}

async function resolveCodexNativeExecutable(
  wrapperPath: string,
): Promise<string> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new AgentAdapterError(
      'agent_setup',
      `Container-native Codex requires linux x64, observed ${process.platform} ${process.arch}.`,
    );
  }
  const executable = path.resolve(
    path.dirname(wrapperPath),
    '..',
    'node_modules',
    '@openai',
    'codex-linux-x64',
    'vendor',
    'x86_64-unknown-linux-musl',
    'bin',
    'codex',
  );
  const metadata = await stat(executable).catch((error: unknown) => {
    throw new AgentAdapterError(
      'agent_setup',
      `Cannot resolve native Codex executable: ${executable}.`,
      { cause: error },
    );
  });
  if (!metadata.isFile()) {
    throw new AgentAdapterError(
      'agent_setup',
      `Native Codex executable is not a regular file: ${executable}.`,
    );
  }
  return executable;
}

function requiredCaptured(
  value: string | undefined,
  stream: 'stdout' | 'stderr',
): string {
  if (value === undefined) {
    throw new AgentAdapterError(
      'agent_process',
      `Agent version process did not capture ${stream}.`,
    );
  }
  return value;
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/u)[0];
  if (line === undefined || line === '') {
    throw new AgentAdapterError(
      'agent_setup',
      'Agent version command returned no version.',
    );
  }
  return line;
}
