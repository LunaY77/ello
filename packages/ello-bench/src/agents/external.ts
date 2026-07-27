import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ClaudeCodeAgentSpec } from '../contracts.js';
import { sha256 } from '../hash.js';
import { runProcess } from '../process.js';

import { AgentAdapterError } from './adapter.js';

export type ExternalAgentSpec = ClaudeCodeAgentSpec;

export interface ExternalRuntimeInspection {
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly observedVersion: string;
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
    env: externalProcessEnvironment({}),
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
  return `${agent.binary.expectedVersion} (Claude Code)`;
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
