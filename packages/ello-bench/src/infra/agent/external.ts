import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentSpec } from '../../domain/contract/index.js';
import { sha256 } from '../../domain/hash.js';
import type { AgentRunContext } from '../../ports/agent.js';
import { CONTAINER_HOME } from '../container-user.js';
import { runProcess } from '../process.js';

import { AgentAdapterError } from './error.js';

export type ExternalAgentSpec = Exclude<AgentSpec, { readonly kind: 'ello' }>;

export interface ExternalRuntimeInspection {
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly observedVersion: string;
}

export async function installExternalExecutable(
  context: AgentRunContext,
  runtime: ExternalRuntimeInspection,
  name: string,
): Promise<string> {
  const directory = '/tmp/ello-bench/bin';
  const target = `${directory}/${name}`;
  const prepared = await context.container.exec(['mkdir', '-p', directory], {
    cwd: context.container.workspace,
    timeoutMs: 30_000,
  });
  if (prepared.process.exitCode !== 0 || prepared.process.timedOut) {
    throw new AgentAdapterError(
      'agent_setup',
      `Cannot create Agent binary directory in container: ${prepared.stderr ?? ''}`,
    );
  }
  await context.container.copyIn(runtime.executablePath, target);
  const executable = await context.container.exec(['chmod', '0500', target], {
    cwd: context.container.workspace,
    timeoutMs: 30_000,
  });
  if (executable.process.exitCode !== 0 || executable.process.timedOut) {
    throw new AgentAdapterError(
      'agent_setup',
      `Cannot make Agent binary executable in container: ${executable.stderr ?? ''}`,
    );
  }
  return target;
}

export function concreteEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export async function prepareContainerAgentHome(
  context: AgentRunContext,
  kind: 'claude' | 'codex',
): Promise<{
  readonly home: string;
  readonly configDirectory: string;
}> {
  const root = `/tmp/ello-bench/${context.attemptId}/${kind}`;
  const configDirectory =
    kind === 'codex' ? `${root}/codex-home` : `${root}/claude-home`;
  const prepared = await context.container.exec(
    ['mkdir', '-p', configDirectory],
    { cwd: context.container.workspace, timeoutMs: 30_000 },
  );
  if (prepared.process.exitCode !== 0 || prepared.process.timedOut) {
    throw new AgentAdapterError(
      'agent_setup',
      `Cannot prepare Agent home in container: ${prepared.stderr ?? ''}`,
    );
  }
  return { home: CONTAINER_HOME, configDirectory };
}

export async function inspectExternalRuntime(
  agent: ExternalAgentSpec,
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
  const versionExecution = await runProcess(executablePath, ['--version'], {
    cwd: process.cwd(),
    env: hostProcessEnvironment({}),
    timeoutMs: 15_000,
    killGraceMs: 2_000,
    capture: true,
    maxOutputBytes: 1024 * 1024,
  });
  const stdout = requiredCaptured(versionExecution.stdout, 'stdout').trim();
  const stderr = requiredCaptured(versionExecution.stderr, 'stderr').trim();
  if (
    versionExecution.result.exitCode !== 0 ||
    versionExecution.result.timedOut
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

export function containerProcessEnvironment(
  overrides: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return { ...overrides };
}

function hostProcessEnvironment(
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
