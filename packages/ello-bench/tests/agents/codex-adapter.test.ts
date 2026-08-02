import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentSpec,
  CodexAgentSpec,
  ResolvedTask,
} from '../../src/domain/contract/index.js';
import { sha256, stableJson } from '../../src/domain/hash.js';
import { createAgentAdapter } from '../../src/infra/agent/factory.js';
import type {
  AgentProcessExecution,
  AgentRunContext,
  NormalizedAgentExecution,
} from '../../src/ports/agent.js';
import { FakeContainerHandle } from '../fake-container.js';

const originalEnvironment = new Map<string, string | undefined>();

afterEach(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnvironment.clear();
});

describe('Codex Agent adapter', () => {
  it('runs an npm-installed Codex symlink through its native package layout', async () => {
    const fixture = await createFixture('success', 'npm-symlink');
    const result = await executeFixture(fixture);

    expect(result.execution.process.exitCode).toBe(0);
    const invocation = JSON.parse(
      await readFile(
        path.join(fixture.context.rawAgentRoot, 'invocation.json'),
        'utf8',
      ),
    ) as { command: string };
    expect(invocation.command).toMatch(/\/codex-runtime\/bin\/codex$/u);
  });

  it('runs Codex exec in an isolated environment and normalizes evidence', async () => {
    const fixture = await createFixture('success');
    const result = await executeFixture(fixture);

    expect(
      await readFile(
        path.join(fixture.context.workspace, 'agent-output.txt'),
        'utf8',
      ),
    ).toBe('codex\n');
    expect(result.execution.process.exitCode).toBe(0);
    expect(result.normalized.runtime).toMatchObject({
      kind: 'codex',
      observedModel: 'gpt-codex-test',
      observedVersion: 'codex-cli 0.145.0',
      reasoningEffort: 'high',
      baseUrl: 'https://example.test/openai/v1',
    });
    expect(result.normalized.evidence).toMatchObject({
      kind: 'codex',
      terminalStatus: 'completed',
      providerFailure: false,
      roundCount: 1,
      usage: {
        status: 'complete',
        requests: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 60,
        cacheWriteTokens: 4,
        reasoningTokens: 5,
        toolCalls: 2,
      },
      tools: {
        total: 2,
        shell: 1,
        edit: 1,
      },
    });
    expect(result.normalized.toolAudit).toMatchObject({
      status: 'passed',
      observedToolCalls: 2,
      shellCalls: 1,
      routedShellCalls: 1,
      fileCalls: 1,
    });
    const invocation = JSON.parse(
      await readFile(
        path.join(fixture.context.rawAgentRoot, 'invocation.json'),
        'utf8',
      ),
    ) as { args: string[]; environment: Record<string, string> };
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        'exec',
        '--json',
        '--strict-config',
        '--ignore-user-config',
        '--ignore-rules',
        '--dangerously-bypass-approvals-and-sandbox',
      ]),
    );
    expect(invocation.args.join('\n')).toContain(
      'model_providers.ello_benchmark=',
    );
    expect(invocation.environment.API_KEY_ENV).toBe('ELLO_TEST_CODEX_API_KEY');
    expect(invocation.environment.HOME).toBe('/root');
    expect(JSON.stringify(invocation)).not.toContain('codex-test-key');
  });

  it('preserves a completed turn when the process exits nonzero', async () => {
    const fixture = await createFixture('nonzero');
    const result = await executeFixture(fixture);

    expect(result.execution.process.exitCode).toBe(7);
    expect(result.normalized.evidence.terminalStatus).toBe('completed');
    expect(result.normalized.providerFailure).toBe(false);
  });

  it('rejects malformed JSONL before normalization', async () => {
    const fixture = await createFixture('malformed');
    const prepared = await createAgentAdapter(fixture.agent).prepare(
      fixture.context,
    );

    await expect(prepared.run()).rejects.toThrow('Invalid Agent JSONL');
    await prepared.close();
  });

  it('classifies a failed Codex turn as a provider failure', async () => {
    const fixture = await createFixture('provider-error');
    const result = await executeFixture(fixture);

    expect(result.normalized.evidence.terminalStatus).toBe('failed');
    expect(result.normalized.evidence.usage.status).toBe('unavailable');
    expect(result.normalized.providerFailure).toBe(true);
    expect(result.normalized.providerFailureMessage).toBe(
      'Codex provider error: selected model is at capacity',
    );
  });

  it('retains incomplete tool evidence on timeout', async () => {
    const fixture = await createFixture('timeout');
    const result = await executeFixture(fixture);

    expect(result.execution.process.timedOut).toBe(true);
    expect(result.normalized.evidence.terminalStatus).toBe('timed_out');
    expect(result.normalized.evidence.usage.status).toBe('unavailable');
    expect(result.normalized.toolAudit.status).toBe('passed');
    expect(result.normalized.toolAudit.shellCalls).toBe(1);
  });

  it('fails the tool audit for a nested Docker command', async () => {
    const fixture = await createFixture('routing-violation');
    const result = await executeFixture(fixture);

    expect(result.normalized.toolAudit.status).toBe('failed');
    expect(result.normalized.toolAudit.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'docker_shell' }),
      ]),
    );
  });

  it('fails the tool audit when Codex emits a network tool', async () => {
    const fixture = await createFixture('web-search');
    const result = await executeFixture(fixture);

    expect(result.normalized.toolAudit.status).toBe('failed');
    expect(result.normalized.toolAudit.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'network_tool' }),
      ]),
    );
  });

  it('records additive Codex wire-format fields as drift', async () => {
    const fixture = await createFixture('upstream-drift');
    const result = await executeFixture(fixture);

    expect(result.normalized.evidence.terminalStatus).toBe('completed');
    expect(result.normalized.evidence.unknownFields).toEqual([
      'Codex command item.future_item_field',
      'Codex turn usage.future_usage_field',
      'Codex turn.completed.future_event_field',
    ]);
  });

  it('fails before execution when its credential is missing', async () => {
    const fixture = await createFixture('success');
    unsetEnvironment('ELLO_TEST_CODEX_API_KEY');

    await expect(
      createAgentAdapter(fixture.agent).prepare(fixture.context),
    ).rejects.toThrow(
      'Missing required environment variable: ELLO_TEST_CODEX_API_KEY.',
    );
  });
});

type FixtureMode =
  | 'success'
  | 'nonzero'
  | 'malformed'
  | 'provider-error'
  | 'timeout'
  | 'routing-violation'
  | 'web-search'
  | 'upstream-drift';

async function createFixture(
  mode: FixtureMode,
  installation: 'standalone' | 'npm-symlink' = 'standalone',
): Promise<{ readonly agent: AgentSpec; readonly context: AgentRunContext }> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-codex-'));
  const workspace = path.join(root, 'workspace');
  const rawAgentRoot = path.join(root, 'raw', 'agent');
  const agentStateRoot = path.join(root, 'agent-state');
  const containerRoot = path.join(root, 'container');
  const binRoot = path.join(root, 'bin');
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(rawAgentRoot, { recursive: true }),
    mkdir(agentStateRoot, { recursive: true }),
    mkdir(containerRoot, { recursive: true }),
    mkdir(binRoot, { recursive: true }),
  ]);
  await writeFile(path.join(workspace, 'README.md'), 'fixture\n', 'utf8');
  const executablePath =
    installation === 'npm-symlink'
      ? await writeNpmCodexInstallation(root, mode)
      : path.join(binRoot, 'codex');
  if (installation === 'standalone') {
    await writeExecutable(executablePath, codexExecutableSource(mode));
  }
  const binarySha256 = sha256(await readFile(executablePath));
  setEnvironment('ELLO_TEST_CODEX_EXE', executablePath);
  setEnvironment('ELLO_TEST_CODEX_API_KEY', 'codex-test-key');
  const agent: CodexAgentSpec = {
    id: 'codex-test',
    displayName: 'Codex test',
    kind: 'codex',
    model: 'gpt-codex-test',
    reasoningEffort: 'high',
    binary: {
      pathEnv: 'ELLO_TEST_CODEX_EXE',
      expectedVersion: '0.145.0',
      sha256: binarySha256,
    },
    connection: {
      baseUrl: 'https://example.test/openai/v1',
      apiKeyEnv: 'ELLO_TEST_CODEX_API_KEY',
      httpHeaders: { 'X-Benchmark': 'codex' },
    },
  };
  const instructionPath = path.join(root, 'instruction.md');
  await writeFile(instructionPath, 'Implement the fixture change.\n', 'utf8');
  const task = resolvedTask(mode === 'timeout' ? 250 : 5_000);
  const context: AgentRunContext = {
    attemptId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    agent,
    agentConfigHash: sha256(stableJson(agent)),
    agentStateRoot,
    workspace,
    rawAgentRoot,
    container: new FakeContainerHandle(workspace, containerRoot),
    taskFiles: {
      task,
      taskRoot: root,
      instruction: 'Implement the fixture change.\n',
      instructionPath,
      verifierScriptPath: path.join(root, 'verifier.sh'),
      verifierPatchPath: path.join(root, 'test.patch'),
    },
  };
  return { agent, context };
}

async function writeNpmCodexInstallation(
  root: string,
  mode: FixtureMode,
): Promise<string> {
  const packageRoot = path.join(
    root,
    'lib',
    'node_modules',
    '@openai',
    'codex',
  );
  const launcherPath = path.join(packageRoot, 'bin', 'codex.js');
  const platformRoot = path.join(
    packageRoot,
    'node_modules',
    '@openai',
    'codex-linux-x64',
  );
  const layoutRoot = path.join(
    platformRoot,
    'vendor',
    'x86_64-unknown-linux-musl',
  );
  const nativeExecutable = path.join(layoutRoot, 'bin', 'codex');
  const executablePath = path.join(root, 'bin', 'codex');
  await Promise.all([
    mkdir(path.dirname(launcherPath), { recursive: true }),
    mkdir(path.dirname(nativeExecutable), { recursive: true }),
  ]);
  await Promise.all([
    writeExecutable(launcherPath, codexLauncherSource()),
    writeExecutable(nativeExecutable, codexExecutableSource(mode)),
    writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@openai/codex', type: 'module' }),
      'utf8',
    ),
    writeFile(
      path.join(platformRoot, 'package.json'),
      JSON.stringify({ name: '@openai/codex' }),
      'utf8',
    ),
    writeFile(
      path.join(layoutRoot, 'codex-package.json'),
      JSON.stringify({
        layoutVersion: 1,
        version: '0.145.0',
        target: 'x86_64-unknown-linux-musl',
        variant: 'codex',
        entrypoint: 'bin/codex',
      }),
      'utf8',
    ),
  ]);
  await symlink(
    '../lib/node_modules/@openai/codex/bin/codex.js',
    executablePath,
  );
  return executablePath;
}

async function executeFixture(fixture: {
  readonly agent: AgentSpec;
  readonly context: AgentRunContext;
}): Promise<{
  readonly execution: AgentProcessExecution;
  readonly normalized: NormalizedAgentExecution;
}> {
  const prepared = await createAgentAdapter(fixture.agent).prepare(
    fixture.context,
  );
  const execution = await prepared.run();
  await prepared.close();
  const normalized = await prepared.normalize(execution);
  return { execution, normalized };
}

function codexExecutableSource(mode: FixtureMode): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.145.0\\n'); process.exit(0); }
const args = process.argv.slice(2);
if (args[0] !== 'exec' || !args.includes('--json') || !args.includes('--strict-config') || !args.includes('--ignore-user-config') || !args.includes('--ignore-rules')) process.exit(61);
const selectedModel = args[args.indexOf('-m') + 1];
const prompt = fs.readFileSync(0, 'utf8');
if (!prompt.includes('Run repository commands directly; do not invoke Docker') || selectedModel !== 'gpt-codex-test') process.exit(62);
if (process.env.HOME !== '/root') process.exit(66);
if (!process.env.CODEX_HOME?.endsWith('/codex/codex-home')) process.exit(63);
if (process.env.ELLO_TEST_CODEX_API_KEY !== 'codex-test-key') process.exit(64);
if (!args.some((value) => value.includes('base_url=\\"https://example.test/openai/v1\\"'))) process.exit(65);
if (mode === 'malformed') { process.stdout.write('{bad json\\n'); process.exit(1); }
const event = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
event({ type: 'thread.started', thread_id: 'thread-1' });
event({ type: 'turn.started', turn_id: 'turn-1', timestamp: '2026-07-28T00:00:00.000Z' });
const command = mode === 'routing-violation' ? 'docker exec forbidden true' : 'echo codex > agent-output.txt';
event({ type: 'item.started', timestamp: '2026-07-28T00:00:01.000Z', item: { id: 'command-1', type: 'command_execution', command, aggregated_output: '', exit_code: null, status: 'in_progress' } });
if (mode === 'timeout') while (true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
if (mode !== 'routing-violation') {
  fs.writeFileSync('agent-output.txt', 'codex\\n');
}
const commandItem = { id: 'command-1', type: 'command_execution', command, aggregated_output: 'ok', exit_code: 0, status: 'completed' };
if (mode === 'upstream-drift') commandItem.future_item_field = true;
event({ type: 'item.completed', timestamp: '2026-07-28T00:00:02.000Z', item: commandItem });
event({ type: 'item.completed', timestamp: '2026-07-28T00:00:03.000Z', item: { id: 'file-1', type: 'file_change', changes: [{ path: 'agent-output.txt', kind: 'update' }], status: 'completed' } });
if (mode === 'web-search') event({ type: 'item.completed', item: { id: 'web-1', type: 'web_search', query: 'forbidden', action: { type: 'search' } } });
event({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'done' } });
if (mode === 'provider-error') {
  event({ type: 'error', message: 'selected model is at capacity' });
  event({ type: 'turn.failed', turn_id: 'turn-1', timestamp: '2026-07-28T00:00:04.000Z', error: { message: 'selected model is at capacity' } });
  process.exit(7);
}
const usage = { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 4, output_tokens: 20, reasoning_output_tokens: 5 };
if (mode === 'upstream-drift') usage.future_usage_field = 1;
const terminal = { type: 'turn.completed', turn_id: 'turn-1', timestamp: '2026-07-28T00:00:04.000Z', usage };
if (mode === 'upstream-drift') terminal.future_event_field = true;
event(terminal);
process.exit(mode === 'nonzero' ? 7 : 0);
`;
}

function codexLauncherSource(): string {
  return `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.145.0\\n'); process.exit(0); }
process.exit(70);
`;
}

async function writeExecutable(
  filePath: string,
  source: string,
): Promise<void> {
  await writeFile(filePath, source, 'utf8');
  await chmod(filePath, 0o755);
}

function setEnvironment(name: string, value: string): void {
  if (!originalEnvironment.has(name)) {
    originalEnvironment.set(name, process.env[name]);
  }
  process.env[name] = value;
}

function unsetEnvironment(name: string): void {
  if (!originalEnvironment.has(name)) {
    originalEnvironment.set(name, process.env[name]);
  }
  delete process.env[name];
}

function resolvedTask(agentTimeoutMs: number): ResolvedTask {
  return {
    schema: 'ello.benchmark.resolved-task.v2',
    benchmark: 'deep-swe',
    taskId: 'fixture-task',
    extId: 'fixture',
    displayTitle: 'Fixture',
    displayDescription: 'Fixture',
    originalTitle: 'Fixture',
    category: 'feature_request',
    language: 'typescript',
    repositoryUrl: 'https://github.com/example/fixture',
    baseCommitHash: 'a'.repeat(40),
    agentTimeoutMs,
    verifierTimeoutMs: 5_000,
    environment: {
      image: 'example/fixture:fixed',
      allowInternet: false,
      buildTimeoutMs: 5_000,
      cpus: 1,
      memoryMb: 1024,
      storageMb: 1024,
    },
    instructionSha256: 'b'.repeat(64),
    verifierScriptSha256: 'c'.repeat(64),
    verifierPatchSha256: 'd'.repeat(64),
  };
}
