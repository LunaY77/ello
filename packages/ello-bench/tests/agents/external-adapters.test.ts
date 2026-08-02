import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentSpec,
  ClaudeCodeAgentSpec,
  ResolvedTask,
} from '../../src/domain/contract/index.js';
import { sha256, stableJson } from '../../src/domain/hash.js';
import {
  claudeCodeBaseUrlIssue,
  requireClaudeCodeBaseUrl,
} from '../../src/infra/agent/claude-code/base-url.js';
import { externalProcessEnvironment } from '../../src/infra/agent/external.js';
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

describe('Claude Code Agent adapter', () => {
  it('inherits the host control-plane PATH', () => {
    setEnvironment('PATH', '/host-only/bin');

    expect(externalProcessEnvironment({ HOME: '/isolated' })).toMatchObject({
      HOME: '/isolated',
      PATH: '/host-only/bin',
    });
  });

  it('rejects a base URL that already contains the version segment', () => {
    expect(() =>
      requireClaudeCodeBaseUrl('https://example.test/anthropic/v1'),
    ).toThrow('must omit the trailing /v1');
    expect(requireClaudeCodeBaseUrl('https://example.test/anthropic')).toBe(
      'https://example.test/anthropic',
    );
    expect(
      claudeCodeBaseUrlIssue('https://example.test/anthropic/v1'),
    ).toContain('appends /v1/messages');
  });

  it('runs a real child process and produces audited evidence', async () => {
    const fixture = await createFixture('success');
    const result = await executeFixture(fixture);

    expect(result.execution.process.exitCode).toBe(0);
    expect(result.normalized.toolAudit.status).toBe('passed');
    expect(result.normalized.evidence.providerFailure).toBe(false);
    expect(result.normalized.evidence.usage).toEqual({
      status: 'complete',
      requests: 2,
      inputTokens: 26,
      outputTokens: 6,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      reasoningTokens: null,
      toolCalls: 1,
    });
    expect(result.normalized.evidence.roundCount).toBe(2);
    expect(result.normalized.runtime).toMatchObject({
      kind: 'claude-code',
      adapterContractVersion: '2',
      reasoningEffort: 'max',
    });
    const invocation = await readFile(
      path.join(fixture.context.rawAgentRoot, 'invocation.json'),
      'utf8',
    );
    expect(invocation).not.toContain('claude-test-key');
    expect(JSON.parse(invocation)).toMatchObject({
      controlRuntime: 'host',
      environment: {
        HOME: path.join(fixture.context.agentStateRoot, 'home'),
        ANTHROPIC_BASE_URL: 'https://example.test/anthropic',
        ANTHROPIC_AUTH_TOKEN_ENV: 'ELLO_TEST_CLAUDE_API_KEY',
      },
      args: expect.arrayContaining(['--effort', 'max']),
      reasoningEffort: 'max',
    });
    expect(
      await readFile(
        path.join(fixture.context.workspace, 'agent-output.txt'),
        'utf8',
      ),
    ).toBe('claude-code\n');
  });
  it('scores a run whose assistant events carry a null stop reason', async () => {
    const fixture = await createFixture('success');
    const result = await executeFixture(fixture);

    expect(result.normalized.evidence.terminalStatus).toBe('completed');
    expect(result.normalized.evidence.providerFailure).toBe(false);
    const rounds = (
      await readFile(
        path.join(fixture.context.rawAgentRoot, 'rounds.jsonl'),
        'utf8',
      )
    )
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rounds).toHaveLength(2);
    for (const round of rounds) {
      expect(round).not.toHaveProperty('finishReason');
    }
  });

  it('treats omitted cache fields as zero without losing later cache usage', async () => {
    const fixture = await createFixture('missing-cache-fields');
    const result = await executeFixture(fixture);

    expect(result.normalized.evidence.usage).toEqual({
      status: 'complete',
      requests: 2,
      inputTokens: 23,
      outputTokens: 6,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      reasoningTokens: null,
      toolCalls: 1,
    });
  });

  it('preserves valid evidence for a nonzero Agent exit', async () => {
    const fixture = await createFixture('nonzero');
    const result = await executeFixture(fixture);

    expect(result.execution.process.exitCode).toBe(7);
    expect(result.normalized.evidence.providerFailure).toBe(false);
    expect(result.normalized.toolAudit.status).toBe('passed');
  });

  it('rejects malformed JSONL', async () => {
    const fixture = await createFixture('malformed');
    const prepared = await createAgentAdapter(fixture.agent).prepare(
      fixture.context,
    );

    await expect(prepared.run()).rejects.toThrow('Invalid Agent JSONL');
    await prepared.close();
  });

  it('reports provider failures from strict terminal evidence', async () => {
    const fixture = await createFixture('provider-error');
    const result = await executeFixture(fixture);

    expect(result.normalized.providerFailure).toBe(true);
    expect(result.normalized.providerFailureMessage).toBe(
      "Claude Code provider error model_not_found: There's an issue with the selected model (claude-opus-4-6[1m]).",
    );
    expect(result.normalized.evidence.observedModel).toBe(
      'claude-opus-4-6[1m]',
    );
    expect(result.normalized.evidence.roundCount).toBe(1);
    expect(result.normalized.evidence.terminalStatus).toBe('failed');
    expect(result.normalized.evidence.unknownFields).toEqual([]);
  });
  it('preserves timeout evidence without inventing usage', async () => {
    const fixture = await createFixture('timeout');
    const result = await executeFixture(fixture);

    expect(result.execution.process.timedOut).toBe(true);
    expect(result.normalized.evidence.terminalStatus).toBe('timed_out');
    expect(result.normalized.evidence.usage.status).toBe('unavailable');
  });

  it('fails tool audit for a host shell command', async () => {
    const fixture = await createFixture('routing-violation');
    const result = await executeFixture(fixture);

    expect(result.normalized.toolAudit.status).toBe('failed');
    expect(result.normalized.toolAudit.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'host_shell' })]),
    );
  });

  it('fails before execution when its credential is missing', async () => {
    const fixture = await createFixture('success');
    unsetEnvironment('ELLO_TEST_CLAUDE_API_KEY');

    await expect(
      createAgentAdapter(fixture.agent).prepare(fixture.context),
    ).rejects.toThrow(
      'Missing required environment variable: ELLO_TEST_CLAUDE_API_KEY.',
    );
  });

  it('scores a run that emits unknown upstream fields and reports the drift', async () => {
    const fixture = await createFixture('upstream-drift');
    const result = await executeFixture(fixture);

    expect(result.normalized.evidence.terminalStatus).toBe('completed');
    expect(result.normalized.toolAudit.status).toBe('passed');
    expect(result.normalized.evidence.unknownFields).toEqual([
      'Claude assistant content.server_tool_use',
      'Claude assistant message.future_field',
      'Claude usage.future_usage_field',
    ]);
  });

  it('accepts the exact enabled tool set in any order', async () => {
    const fixture = await createFixture('reordered-tools');
    const result = await executeFixture(fixture);

    expect(result.normalized.evidence.providerFailure).toBe(false);
  });

  it('保留长命令心跳事件的 evidence，不因未消费的事件类型整体失败', async () => {
    const fixture = await createFixture('tool-progress');
    const result = await executeFixture(fixture);

    expect(result.normalized.evidence.terminalStatus).toBe('completed');
    expect(result.normalized.evidence.usage.status).toBe('complete');
    expect(result.normalized.evidence.unknownFields).toEqual([]);
  });

  it('rejects a changed enabled tool set', async () => {
    const fixture = await createFixture('tool-mismatch');
    const prepared = await createAgentAdapter(fixture.agent).prepare(
      fixture.context,
    );
    const execution = await prepared.run();
    await prepared.close();

    await expect(prepared.normalize(execution)).rejects.toThrow(
      'Claude enabled tools mismatch',
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
  | 'reordered-tools'
  | 'tool-mismatch'
  | 'upstream-drift'
  | 'tool-progress'
  | 'missing-cache-fields';

async function createFixture(
  mode: FixtureMode,
): Promise<{ readonly agent: AgentSpec; readonly context: AgentRunContext }> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-claude-code-'));
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
  const executablePath = path.join(binRoot, 'claude');
  await writeExecutable(executablePath, claudeExecutableSource(mode));
  const binarySha256 = sha256(await readFile(executablePath));
  setEnvironment('ELLO_TEST_CLAUDE_EXE', executablePath);
  setEnvironment('ELLO_TEST_CLAUDE_API_KEY', 'claude-test-key');
  const agent: ClaudeCodeAgentSpec = {
    id: 'claude-test',
    displayName: 'Claude Code test',
    kind: 'claude-code',
    model: 'claude-opus-4-6[1m]',
    reasoningEffort: 'max',
    binary: {
      pathEnv: 'ELLO_TEST_CLAUDE_EXE',
      expectedVersion: '2.1.217',
      sha256: binarySha256,
    },
    connection: {
      baseUrl: 'https://example.test/anthropic',
      apiKeyEnv: 'ELLO_TEST_CLAUDE_API_KEY',
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

function claudeExecutableSource(mode: FixtureMode): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
if (process.argv.includes('--version')) { process.stdout.write('2.1.217 (Claude Code)\\n'); process.exit(0); }
if (mode === 'malformed') { process.stdout.write('{bad json\\n'); process.exit(1); }
const args = process.argv.slice(2);
const selectedModel = args[args.indexOf('--model') + 1];
const selectedEffort = args[args.indexOf('--effort') + 1];
const boundary = args[args.indexOf('--append-system-prompt') + 1];
fs.readFileSync(0, 'utf8');
if (selectedEffort !== 'max') process.exit(70);
if (!boundary.includes("docker exec -w /app bench-container bash -c '<command>'")) process.exit(65);
if (!process.env.HOME?.endsWith('/agent-state/home')) process.exit(66);
if (!process.env.CLAUDE_CONFIG_DIR?.endsWith('/agent-state/home/.claude')) process.exit(69);
if (process.env.ANTHROPIC_BASE_URL !== 'https://example.test/anthropic') process.exit(67);
if (process.env.ANTHROPIC_AUTH_TOKEN !== 'claude-test-key') process.exit(68);
const tools = mode === 'reordered-tools'
  ? ['Bash','Edit','Glob','Grep','Read','Write']
  : mode === 'tool-mismatch'
    ? ['Bash','Edit','Glob','Grep','Read','WebFetch']
    : ['Bash','Edit','Read','Write','Glob','Grep'];
const system = { type: 'system', subtype: 'init', cwd: process.cwd(), session_id: 'session-1', tools, mcp_servers: [], model: selectedModel, permissionMode: 'bypassPermissions', claude_code_version: '2.1.217' };
process.stdout.write(JSON.stringify(system) + '\\n');
if (mode === 'timeout') while (true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
const usage = mode === 'upstream-drift'
  ? { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 1, cache_read_input_tokens: 2, future_usage_field: 'added upstream' }
  : { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 };
if (mode === 'provider-error') {
  const result = "There's an issue with the selected model (" + selectedModel + ').';
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', id: 'msg-provider-error', type: 'message', role: 'assistant', content: [{ type: 'text', text: result }], stop_reason: 'stop_sequence', stop_sequence: '', stop_details: null, usage }, session_id: 'session-1', error: 'model_not_found' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, duration_ms: 1, num_turns: 1, result, session_id: 'session-1', usage, api_error_status: 404, terminal_reason: 'api_error' }) + '\\n');
  process.exit(7);
}
const command = mode === 'routing-violation'
  ? 'git status'
  : "docker exec -w /app bench-container bash -c 'echo claude-code > agent-output.txt'";
if (mode !== 'routing-violation') {
  fs.writeFileSync('agent-output.txt', 'claude-code\\n');
}
const firstUsage = mode === 'missing-cache-fields'
  ? { input_tokens: 10, output_tokens: 0 }
  : usage;
for (const content of [
  [{ type: 'thinking', thinking: 'inspect', signature: 'sig-1' }],
  [{ type: 'text', text: 'running' }],
  [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command } }],
]) {
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-test', id: 'msg-1', type: 'message', role: 'assistant', content, stop_reason: null, usage: firstUsage }, session_id: 'session-1' }) + '\\n');
}
process.stdout.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }] }, session_id: 'session-1' }) + '\\n');
if (mode === 'tool-progress') process.stdout.write(JSON.stringify({ type: 'tool_progress', tool_use_id: 'tool-1-heartbeat-0', tool_name: 'Bash', parent_tool_use_id: 'tool-1', elapsed_time_seconds: 30, heartbeat: true, session_id: 'session-1', uuid: 'progress-1' }) + '\\n');
const secondContent = mode === 'upstream-drift'
  ? [{ type: 'text', text: 'done' }, { type: 'server_tool_use', id: 'srv-1', name: 'web_search', input: {} }]
  : [{ type: 'text', text: 'done' }];
const secondMessage = mode === 'upstream-drift'
  ? { model: 'claude-opus-test', id: 'msg-2', type: 'message', role: 'assistant', content: secondContent, stop_reason: null, usage, future_field: 'added upstream' }
  : { model: 'claude-opus-test', id: 'msg-2', type: 'message', role: 'assistant', content: secondContent, stop_reason: null, usage };
process.stdout.write(JSON.stringify({ type: 'assistant', message: secondMessage, session_id: 'session-1' }) + '\\n');
const terminalUsage = {
  input_tokens: firstUsage.input_tokens + usage.input_tokens,
  output_tokens: 6,
  cache_creation_input_tokens: (firstUsage.cache_creation_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
  cache_read_input_tokens: (firstUsage.cache_read_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
  ...(mode === 'upstream-drift' ? { future_usage_field: 'added upstream' } : {}),
};
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 2, num_turns: 2, result: 'done', session_id: 'session-1', usage: terminalUsage, stop_reason: 'end_turn', terminal_reason: 'completed' }) + '\\n');
process.exit(mode === 'nonzero' ? 7 : 0);
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
