import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { AgentModelRequest, AgentModelResponse, ModelAdapter } from '@ello/agent';
import { afterEach, describe, expect, it } from 'vitest';

import { formatCodingAgentEventOutput } from '../cli/output.js';
import { loadCodingAgentConfig } from '../config.js';
import { createCodingContextReducers } from '../context/reducers.js';
import { evaluateToolPermission, PermissionStore } from '../permissions.js';
import { ProductEventStore } from '../product/event-store.js';
import { CodingAgentRuntime } from '../product/runtime.js';
import { runRpcServer } from '../rpc/server.js';
import { JsonlSessionRepository } from '../session/repository.js';
import { handleSlashCommand } from '../slash-commands.js';
import { selectFooter } from '../tui/state/selectors.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('coding-agent breaking runtime', () => {
  it('runs text-only prompts through ProductEventStore and JSONL session repository', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({ cwd, sessionDir, model: 'fake:test', approvalMode: 'default' });
    const runtime = await CodingAgentRuntime.create({ config, modelAdapter: new FakeModelAdapter('OK') });
    const events: string[] = [];
    const unsubscribe = runtime.events.subscribe((event) => events.push(event.type));

    await runtime.submit('Say OK');
    unsubscribe();
    await runtime.close();

    expect(events).toContain('run.started');
    expect(events).toContain('message.delta');
    expect(events).toContain('run.completed');
    const sessions = await new JsonlSessionRepository({ sessionDir, cwd }).list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.entryCount).toBeGreaterThan(0);
  });

  it('keeps session records append-only and exposes active messages', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const repository = new JsonlSessionRepository({ cwd, sessionDir });
    const opened = await repository.open('s1');
    const leaf = await repository.appendMessages(opened.info.sessionId, opened.leafEntryId, [{ role: 'user', content: 'hello' }]);
    await repository.appendMessages(opened.info.sessionId, leaf, [{ role: 'assistant', content: 'world' }]);

    const loaded = await repository.load('s1');
    expect(loaded.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(loaded.records.filter((record) => record.kind === 'entry')).toHaveLength(2);
    const tree = await repository.tree('s1');
    expect(tree.nodes.map((node) => node.label)).toEqual(['user hello', 'assistant world']);
    expect(await repository.exportHtml('s1')).toContain('<!doctype html>');
    const forked = await repository.fork('s1', 'test');
    expect(forked.sessionId).not.toBe('s1');
  });

  it('executes the original tool call after approval and resumes the run', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({ cwd, sessionDir, model: 'fake:approval', approvalMode: 'default' });
    const runtime = await CodingAgentRuntime.create({ config, modelAdapter: new ApprovalModelAdapter() });
    const seen: string[] = [];
    const unsubscribe = runtime.events.subscribe((event) => seen.push(event.type));

    await runtime.submit('write a file');
    expect(seen).toContain('approval.requested');
    await runtime.approve('call_write', { action: 'approve_once' });
    unsubscribe();
    await runtime.close();

    await expect(readFile(path.join(cwd, 'approved.txt'), 'utf8')).resolves.toBe('approved');
    expect(seen).toContain('approval.resolved');
    expect(seen).toContain('run.completed');
  });

  it('applies plan and accept-edits permission modes', () => {
    expect(evaluateToolPermission({ toolName: 'read', cwd: '/repo', allowedPaths: ['/repo'], mode: 'plan', input: { path: 'a.ts' } }).action).toBe('allow');
    expect(evaluateToolPermission({ toolName: 'write', cwd: '/repo', allowedPaths: ['/repo'], mode: 'plan', input: { path: 'a.ts' } }).action).toBe('deny');
    expect(evaluateToolPermission({ toolName: 'edit', cwd: '/repo', allowedPaths: ['/repo'], mode: 'accept-edits', input: { path: 'a.ts' } }).action).toBe('allow');
    expect(evaluateToolPermission({ toolName: 'bash', cwd: '/repo', allowedPaths: ['/repo'], mode: 'accept-edits', input: { command: 'pnpm test' } }).action).toBe('ask');
  });

  it('keeps denied tool names in product events', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({ cwd, sessionDir, model: 'fake:denied', approvalMode: 'plan' });
    const runtime = await CodingAgentRuntime.create({ config, modelAdapter: new BashOnlyModelAdapter() });

    await runtime.submit('run bash');
    const completed = runtime.events.snapshot().completedTools;
    await runtime.close();

    expect(completed[0]).toMatchObject({
      name: 'bash',
      status: 'error',
      input: { command: 'printf OK' },
    });
  });

  it('persists permission rules for session and local config', async () => {
    const cwd = await tempDir();
    const store = new PermissionStore(cwd);
    await store.addRule({ action: 'allow', tool: 'bash', commandPattern: 'pnpm test', scope: 'session' });
    expect(store.rules()).toHaveLength(1);
    await store.addRule({ action: 'deny', tool: 'web_fetch', domain: 'example.com', scope: 'default' });
    const localConfig = JSON.parse(await readFile(path.join(cwd, '.ello', 'local.json'), 'utf8')) as { permissionRules: unknown[] };
    expect(localConfig.permissionRules).toHaveLength(1);
  });

  it('loads local ignored config overrides', async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, '.ello'), { recursive: true });
    await writeFile(path.join(cwd, '.ello', 'local.json'), JSON.stringify({ approvalMode: 'plan' }), 'utf8');
    await expect(loadCodingAgentConfig({ cwd, sessionDir: await tempDir() })).resolves.toMatchObject({ approvalMode: 'plan' });
  });

  it('formats CLI output and slash command registry results', async () => {
    const cwd = await tempDir();
    const config = await loadCodingAgentConfig({ cwd, sessionDir: await tempDir() });
    expect(formatCodingAgentEventOutput({ type: 'message.delta', sessionId: 's', runId: 'r', messageId: 'm', text: 'hello', createdAt: new Date().toISOString() }, false)).toBe('hello');
    expect(handleSlashCommand('/compact', config).command).toMatchObject({ type: 'runtime-action', action: 'compact' });
    expect(handleSlashCommand('/model fake:test', config).command).toMatchObject({ type: 'set-model', model: 'fake:test' });
  });

  it('folds product events into TUI selectors', () => {
    const store = new ProductEventStore();
    const createdAt = new Date().toISOString();
    store.append({ type: 'session.started', sessionId: 's', session: { sessionId: 's', cwd: '/repo', path: '/tmp/s.jsonl', createdAt }, createdAt });
    store.append({ type: 'run.started', sessionId: 's', runId: 'r', input: { prompt: 'hello', source: 'submit' }, createdAt });
    store.append({ type: 'message.delta', sessionId: 's', runId: 'r', messageId: 'm', text: 'world', createdAt });
    store.append({ type: 'usage.updated', sessionId: 's', usage: { requests: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, contextPressure: 12 }, createdAt });

    const snapshot = store.snapshot();
    expect(snapshot.currentAssistantText).toBe('world');
    expect(store.all().filter((event) => event.type === 'message.delta')).toHaveLength(1);
    expect(selectFooter({ cwd: '/repo', model: 'fake:test', mode: 'default', snapshot }).context).toBe('ctx 12%');
  });

  it('adds structured render metadata for bash and write tools', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({ cwd, sessionDir, model: 'fake:tools', approvalMode: 'bypass' });
    const runtime = await CodingAgentRuntime.create({ config, modelAdapter: new ToolModelAdapter() });

    await runtime.submit('run tools');
    const completed = runtime.events.snapshot().completedTools;
    await runtime.close();

    expect(completed.find((tool) => tool.name === 'bash')?.render).toMatchObject({ kind: 'bash', stdout: expect.stringContaining('hello') });
    expect(completed.find((tool) => tool.name === 'write')?.render).toMatchObject({ kind: 'diff', diff: expect.stringContaining('+++ note.txt') });
  });

  it('reduces long tool results and token budget pressure', async () => {
    const [toolReducer, budgetReducer] = createCodingContextReducers({ toolResultMaxChars: 100, maxInputTokens: 80 });
    const longToolMessage = { role: 'tool' as const, content: 'x'.repeat(500) };
    const reducedTool = await toolReducer.reduce({
      bundles: [{ kind: 'message', source: 'tool', priority: 10, scope: 'run', retention: 'compressible', persist: 'session', message: longToolMessage }],
      ctx: fakeRunContext(),
      budget: {},
    });
    expect(JSON.stringify(reducedTool.bundles[0])).toContain('truncated');

    const reducedBudget = await budgetReducer.reduce({
      bundles: [
        { kind: 'system', source: 'fixed', priority: 100, scope: 'run', retention: 'fixed', persist: 'never', text: 'fixed' },
        { kind: 'system', source: 'drop', priority: 1, scope: 'run', retention: 'droppable', persist: 'never', text: 'x'.repeat(1000) },
      ],
      ctx: fakeRunContext(),
      budget: {},
    });
    expect(reducedBudget.bundles.map((bundle) => bundle.source)).toEqual(['fixed']);
  });

  it('persists compact summaries and exposes them to session tree clients', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({ cwd, sessionDir, model: 'fake:test' });
    const runtime = await CodingAgentRuntime.create({ config, modelAdapter: new FakeModelAdapter('OK') });

    await runtime.submit('Say OK');
    await runtime.compact();
    const tree = await runtime.sessionTree();
    const summary = await new JsonlSessionRepository({ cwd, sessionDir }).latestCompactionSummary(runtime.sessionId);
    await runtime.close();

    expect(tree.compactions).toHaveLength(1);
    expect(summary).toContain('Compacted');
  });

  it('serves session actions over JSONL RPC without touching TUI state', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({ cwd, sessionDir, model: 'fake:test' });
    const lines = [
      JSON.stringify({ id: '1', method: 'tree' }),
      JSON.stringify({ id: '2', method: 'newSession' }),
      JSON.stringify({ id: '3', method: 'close' }),
    ].join('\n') + '\n';
    const output: string[] = [];

    await runRpcServer(config, {
      stdin: Readable.from([lines]),
      stdout: { write: (chunk: string) => { output.push(chunk); return true; } },
    });

    const responses = output
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; id?: string; ok?: boolean; result?: unknown });
    expect(responses.filter((line) => line.type === 'response').map((line) => [line.id, line.ok])).toEqual([
      ['1', true],
      ['2', true],
      ['3', true],
    ]);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ello-coding-agent-'));
  dirs.push(dir);
  return dir;
}

class FakeModelAdapter implements ModelAdapter {
  constructor(private readonly text: string) {}

  async generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    return {
      text: this.text,
      messages: [...request.messages, { role: 'assistant', content: this.text }],
      newMessages: [{ role: 'assistant', content: this.text }],
      usage: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 },
      finishReason: 'stop',
      provider: { fake: true },
    };
  }

  async *stream(request: AgentModelRequest) {
    yield { type: 'text-delta' as const, text: this.text };
    yield { type: 'final' as const, response: await this.generate(request) };
  }
}

class ApprovalModelAdapter implements ModelAdapter {
  private resumed = false;

  async generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    if (!this.resumed) {
      this.resumed = true;
      return {
        text: '',
        messages: [...request.messages],
        newMessages: [],
        toolCalls: [{ id: 'call_write', name: 'write', input: { path: 'approved.txt', content: 'approved' } }],
        usage: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 },
        finishReason: 'tool-calls',
        provider: { fake: true },
      };
    }
    return {
      text: 'done',
      messages: [...request.messages, { role: 'assistant', content: 'done' }],
      newMessages: [{ role: 'assistant', content: 'done' }],
      usage: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 },
      finishReason: 'stop',
      provider: { fake: true },
    };
  }

  async *stream(request: AgentModelRequest) {
    const response = await this.generate(request);
    yield { type: 'text-delta' as const, text: response.text };
    yield { type: 'final' as const, response };
  }
}

class ToolModelAdapter implements ModelAdapter {
  private calls = 0;

  async generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        text: '',
        messages: [...request.messages],
        newMessages: [],
        toolCalls: [
          { id: 'call_bash', name: 'bash', input: { command: 'printf hello' } },
          { id: 'call_write', name: 'write', input: { path: 'note.txt', content: 'hello\n' } },
        ],
        usage: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 },
        finishReason: 'tool-calls',
        provider: { fake: true },
      };
    }
    return {
      text: 'done',
      messages: [...request.messages, { role: 'assistant', content: 'done' }],
      newMessages: [{ role: 'assistant', content: 'done' }],
      usage: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 },
      finishReason: 'stop',
      provider: { fake: true },
    };
  }

  async *stream(request: AgentModelRequest) {
    const response = await this.generate(request);
    yield { type: 'text-delta' as const, text: response.text };
    yield { type: 'final' as const, response };
  }
}

class BashOnlyModelAdapter implements ModelAdapter {
  async generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    const hasToolResult = request.messages.some((message) => message.role === 'tool');
    if (!hasToolResult) {
      return {
        text: '',
        messages: [...request.messages],
        newMessages: [],
        toolCalls: [{ id: 'call_bash', name: 'bash', input: { command: 'printf OK' } }],
        usage: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 },
        finishReason: 'tool-calls',
        provider: { fake: true },
      };
    }
    return {
      text: 'done',
      messages: [...request.messages, { role: 'assistant', content: 'done' }],
      newMessages: [{ role: 'assistant', content: 'done' }],
      usage: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 },
      finishReason: 'stop',
      provider: { fake: true },
    };
  }

  async *stream(request: AgentModelRequest) {
    yield { type: 'final' as const, response: await this.generate(request) };
  }
}

function fakeRunContext(): Parameters<ReturnType<typeof createCodingContextReducers>[number]['reduce']>[0]['ctx'] {
  return {
    runId: 'r',
    agentName: 'test',
    input: 'test',
    context: undefined,
    options: {},
    environment: {},
    metadata: {},
    state: { messages: [], budget: {}, turn: 0, queueDiagnostics: [] },
    trace: { events: [], metadata: {} },
  };
}
