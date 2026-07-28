import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { checkAnalysisToolchain } from './analysis.js';
import type { AgentSpec, BenchmarkConfig } from './contracts.js';
import { sha256 } from './hash.js';
import { runProcess } from './process.js';
import { REPOSITORY_ROOT } from './provenance.js';

export interface DoctorCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export async function runDoctor(
  config: BenchmarkConfig,
  selectedAgentIds: ReadonlySet<string>,
): Promise<{
  readonly ready: boolean;
  readonly checks: readonly DoctorCheck[];
  readonly charts: DoctorCheck;
}> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    label: 'Node.js',
    ok: Number.isInteger(nodeMajor) && nodeMajor >= 24,
    detail: process.versions.node,
  });
  checks.push(await commandCheck('Git', 'git', ['--version']));
  checks.push(await commandCheck('Docker CLI', 'docker', ['--version']));
  checks.push(
    await commandCheck('Docker daemon', 'docker', [
      'info',
      '--format',
      '{{.ServerVersion}}',
    ]),
  );
  for (const agent of config.agents) {
    if (!selectedAgentIds.has(agent.id)) continue;
    if (agent.kind === 'ello') {
      for (const model of Object.values(agent.models)) {
        const value = process.env[model.apiKeyEnv];
        checks.push({
          label: `Credential ${agent.id}/${model.apiKeyEnv}`,
          ok: value !== undefined && value !== '',
          detail: model.apiKeyEnv,
        });
      }
    } else {
      checks.push(...(await externalAgentChecks(agent)));
    }
  }
  const toolchain = await checkAnalysisToolchain();
  const charts = { label: 'Configured report renderer', ...toolchain };
  return {
    ready:
      checks.every((check) => check.ok) &&
      (!config.report.renderCharts || charts.ok),
    checks,
    charts,
  };
}

async function externalAgentChecks(
  agent: Exclude<AgentSpec, { readonly kind: 'ello' }>,
): Promise<DoctorCheck[]> {
  const binaryValue = process.env[agent.binary.pathEnv];
  if (binaryValue === undefined || binaryValue === '') {
    return [
      {
        label: `Executable ${agent.id}`,
        ok: false,
        detail: `Missing ${agent.binary.pathEnv}`,
      },
    ];
  }
  const binaryPath = path.resolve(binaryValue);
  const checks: DoctorCheck[] = [];
  try {
    const metadata = await stat(binaryPath);
    checks.push({
      label: `Executable ${agent.id}`,
      ok: metadata.isFile(),
      detail: binaryPath,
    });
    checks.push(await externalCapabilityCheck(agent, binaryPath));
    const actualHash = sha256(await readFile(binaryPath));
    checks.push({
      label: `Executable checksum ${agent.id}`,
      ok: actualHash === agent.binary.sha256,
      detail: actualHash,
    });
    const version = await commandCheck(
      `Executable version ${agent.id}`,
      binaryPath,
      ['--version'],
    );
    checks.push({
      ...version,
      ok: version.ok && version.detail === expectedVersionOutput(agent),
    });
  } catch (error) {
    checks.push({
      label: `Executable ${agent.id}`,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  switch (agent.kind) {
    case 'claude-code': {
      const apiKey = process.env[agent.connection.apiKeyEnv];
      checks.push({
        label: `Credential ${agent.id}`,
        ok: apiKey !== undefined && apiKey !== '',
        detail: agent.connection.apiKeyEnv,
      });
      break;
    }
    case 'codex': {
      const apiKey = process.env[agent.connection.apiKeyEnv];
      checks.push({
        label: `Credential ${agent.id}`,
        ok: apiKey !== undefined && apiKey !== '',
        detail: agent.connection.apiKeyEnv,
      });
      break;
    }
  }
  return checks;
}

async function externalCapabilityCheck(
  agent: Exclude<AgentSpec, { readonly kind: 'ello' }>,
  binaryPath: string,
): Promise<DoctorCheck> {
  try {
    const execution = await runProcess(binaryPath, requiredHelpArgs(agent), {
      cwd: REPOSITORY_ROOT,
      timeoutMs: 15_000,
      killGraceMs: 2_000,
      capture: true,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    const stdout = requireCapturedOutput(
      execution.stdout,
      binaryPath,
      'stdout',
    );
    const stderr = requireCapturedOutput(
      execution.stderr,
      binaryPath,
      'stderr',
    );
    const output = `${stdout}\n${stderr}`;
    const missing = requiredHelpFlags(agent).filter(
      (flag) => !output.includes(flag),
    );
    return {
      label: `Executable capabilities ${agent.id}`,
      ok: execution.result.exitCode === 0 && missing.length === 0,
      detail:
        missing.length === 0
          ? 'required non-interactive JSON flags available'
          : `Missing flags: ${missing.join(', ')}`,
    };
  } catch (error) {
    return {
      label: `Executable capabilities ${agent.id}`,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function requiredHelpArgs(
  agent: Exclude<AgentSpec, { readonly kind: 'ello' }>,
): readonly string[] {
  return agent.kind === 'codex' ? ['exec', '--help'] : ['--help'];
}

function requiredHelpFlags(
  agent: Exclude<AgentSpec, { readonly kind: 'ello' }>,
): readonly string[] {
  switch (agent.kind) {
    case 'claude-code':
      return [
        '--output-format',
        '--safe-mode',
        '--setting-sources',
        '--strict-mcp-config',
        '--dangerously-skip-permissions',
      ];
    case 'codex':
      return [
        '--json',
        '--strict-config',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--ignore-rules',
        '--dangerously-bypass-approvals-and-sandbox',
      ];
  }
}

function expectedVersionOutput(
  agent: Exclude<AgentSpec, { readonly kind: 'ello' }>,
): string {
  switch (agent.kind) {
    case 'claude-code':
      return `${agent.binary.expectedVersion} (Claude Code)`;
    case 'codex':
      return `codex-cli ${agent.binary.expectedVersion}`;
  }
}

async function commandCheck(
  label: string,
  command: string,
  args: readonly string[],
): Promise<DoctorCheck> {
  try {
    const execution = await runProcess(command, args, {
      cwd: REPOSITORY_ROOT,
      timeoutMs: 15_000,
      killGraceMs: 2_000,
      capture: true,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    const stdout = requireCapturedOutput(execution.stdout, command, 'stdout');
    const stderr = requireCapturedOutput(execution.stderr, command, 'stderr');
    const detail = firstLine(stdout.trim() === '' ? stderr : stdout);
    return { label, ok: execution.result.exitCode === 0, detail };
  } catch (error) {
    return {
      label,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function firstLine(value: string): string {
  const line = value.trim().split(/\r?\n/u)[0];
  return line === undefined || line === '' ? '<no output>' : line;
}

function requireCapturedOutput(
  value: string | undefined,
  command: string,
  stream: 'stdout' | 'stderr',
): string {
  if (value === undefined) {
    throw new Error(`Captured process ${command} did not return ${stream}.`);
  }
  return value;
}
