import { access, mkdtemp, rm, utimes } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  AgentModelEvent,
  AgentModelRequest,
  AgentModelResponse,
  ModelAdapter,
} from '@ello/agent';
import { afterEach, describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config/index.js';
import { createCodingSession } from '../runtime/coding-session.js';
import type { CodingSessionEvent } from '../runtime/intents.js';
import { JsonlSessionRepository } from '../session/repository.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ello-session-'));
  dirs.push(dir);
  return dir;
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = await read();
    if (accept(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return read();
}

/** 统一的 usage 占位。 */
const usage = {
  requests: 1,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  toolCalls: 0,
};

/** 纯文本回应的脚本化适配器：吐两段增量 + 一个 stop final。 */
class TextAdapter implements ModelAdapter {
  constructor(private readonly text: string) {}
  async generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    return {
      text: this.text,
      messages: [
        ...request.messages,
        { role: 'assistant', content: this.text },
      ],
      newMessages: [{ role: 'assistant', content: this.text }],
      usage,
      finishReason: 'stop',
      provider: null,
    };
  }
  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent> {
    yield { type: 'text-delta', text: this.text };
    yield { type: 'final', response: await this.generate(request) };
  }
}

describe('createCodingSession', () => {
  it('streams a text-only run and persists the session to JSONL', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'default',
    });
    const session = await createCodingSession({
      config,
      modelAdapter: new TextAdapter('OK'),
    });
    const types: string[] = [];
    session.subscribe((event: CodingSessionEvent) => types.push(event.type));

    const result = await session.submit('Say OK');
    await session.close();

    expect(types).toContain('run.started');
    expect(types).toContain('message.delta');
    expect(types).toContain('run.completed');
    expect(result.output).toBe('OK');
  });

  it('switches the active profile primary model for the next run', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'default',
    });
    const seenModels: AgentModelRequest['model'][] = [];
    const adapter: ModelAdapter = {
      async generate(request) {
        seenModels.push(request.model);
        return {
          text: 'OK',
          messages: [...request.messages, { role: 'assistant', content: 'OK' }],
          newMessages: [{ role: 'assistant', content: 'OK' }],
          usage,
          finishReason: 'stop',
          provider: null,
        };
      },
      async *stream(request) {
        yield { type: 'final', response: await this.generate(request) };
      },
    };
    const session = await createCodingSession({
      config,
      modelAdapter: adapter,
    });

    expect(await session.setPrimaryModel('openai/gpt-5.4')).toBe(
      'openai/gpt-5.4',
    );
    await session.submit('Say OK');
    await session.close();

    expect(seenModels).toEqual(['openai/gpt-5.4']);
  });

  it('creates and deletes profile suites in the runtime registry', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'default',
    });
    const session = await createCodingSession({
      config,
      modelAdapter: new TextAdapter('OK'),
    });

    await session.createProfile('fast', 'main');
    expect(
      await session.setProfileRoleModel('fast', 'primary', 'openai/gpt-5.4'),
    ).toBe('openai/gpt-5.4');
    await session.deleteProfile('fast');

    await expect(
      session.setProfileRoleModel('fast', 'primary', 'openai/gpt-5.5'),
    ).rejects.toThrow('Unknown profile: fast');
    await session.close();
  });

  it('defers write tools for approval and resumes after approve_once', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'default',
    });

    const target = path.join(cwd, 'note.txt');
    let turn = 0;
    const seenRequests: AgentModelRequest[] = [];
    const adapter: ModelAdapter = {
      async generate(request) {
        turn += 1;
        seenRequests.push(request);
        // 第一轮请求写文件（需审批）；恢复后第二轮收尾。
        if (turn === 1) {
          const toolCallMessage = {
            role: 'assistant' as const,
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call_read',
                toolName: 'read',
                input: { path: target, limit: 100 },
              },
            ],
          };
          return {
            text: '',
            messages: [...request.messages, toolCallMessage],
            newMessages: [toolCallMessage],
            toolCalls: [
              {
                id: 'call_1',
                name: 'write',
                input: { path: target, content: 'hi' },
              },
            ],
            usage,
            finishReason: 'tool-calls',
            provider: null,
          };
        }
        return {
          text: 'wrote it',
          messages: [
            ...request.messages,
            { role: 'assistant', content: 'wrote it' },
          ],
          newMessages: [{ role: 'assistant', content: 'wrote it' }],
          usage,
          finishReason: 'stop',
          provider: null,
        };
      },
      async *stream(request) {
        yield { type: 'final', response: await this.generate(request) };
      },
    };

    const session = await createCodingSession({
      config,
      modelAdapter: adapter,
    });
    const pending: {
      requestId: string;
      toolName: string;
      metadata?: Record<string, unknown>;
    }[] = [];
    session.subscribe((event) => {
      if (event.type === 'approval.pending') {
        pending.push({
          requestId: event.requestId,
          toolName: event.toolName,
          ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
        });
      }
    });

    await session.submit('write a note');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolName).toBe('write');
    expect(pending[0]?.metadata).toMatchObject({
      kind: 'edit',
      path: target,
    });
    expect(String(pending[0]?.metadata?.diff)).toContain('+++');

    await session.approve(pending[0]!.requestId, { action: 'approve_once' });
    await session.close();

    // 审批通过后工具真正执行：文件落盘。
    expect(await readFile(target, 'utf8')).toBe('hi');
    expect(
      seenRequests[1]?.messages.some(
        (message) =>
          message.role === 'tool' &&
          Array.isArray((message as { content?: unknown }).content) &&
          (message as { content: Array<{ toolCallId?: string }> }).content.some(
            (part) => part.toolCallId === 'call_1',
          ),
      ),
    ).toBe(true);
  });

  it('stores subagent transcript in parent sidechain without polluting session list', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'bypass',
    });

    let parentTurns = 0;
    const events: string[] = [];
    let parentFollowUpContent = '';
    const adapter: ModelAdapter = {
      async generate(request) {
        const isParent = Object.hasOwn(request.tools, 'delegate_to_subagent');
        if (!isParent) {
          return {
            text: 'sub done',
            messages: [
              ...request.messages,
              { role: 'assistant', content: 'sub done' },
            ],
            newMessages: [{ role: 'assistant', content: 'sub done' }],
            usage,
            finishReason: 'stop',
            provider: null,
          };
        }

        parentTurns += 1;
        if (parentTurns === 2) {
          parentFollowUpContent = JSON.stringify(request.messages);
        }
        if (parentTurns === 1) {
          const toolCallMessage = {
            role: 'assistant' as const,
            content: [
              {
                type: 'tool-call',
                toolCallId: 'delegate-1',
                toolName: 'delegate_to_subagent',
                input: {
                  name: 'general',
                  description: 'check sidechain',
                  prompt: 'return sub done',
                  run_id: 'run-sidechain',
                },
              },
            ],
          };
          return {
            text: '',
            messages: [...request.messages, toolCallMessage],
            newMessages: [toolCallMessage],
            toolCalls: [
              {
                id: 'delegate-1',
                name: 'delegate_to_subagent',
                input: {
                  name: 'general',
                  description: 'check sidechain',
                  prompt: 'return sub done',
                  run_id: 'run-sidechain',
                },
              },
            ],
            usage,
            finishReason: 'tool-calls',
            provider: null,
          };
        }

        return {
          text: 'parent done',
          messages: [
            ...request.messages,
            { role: 'assistant', content: 'parent done' },
          ],
          newMessages: [{ role: 'assistant', content: 'parent done' }],
          usage,
          finishReason: 'stop',
          provider: null,
        };
      },
      async *stream(request) {
        yield { type: 'final', response: await this.generate(request) };
      },
    };

    const session = await createCodingSession({ config, modelAdapter: adapter });
    session.subscribe((event) => events.push(event.type));

    await session.submit('delegate it');
    const parentId = session.sessionId;
    const sessions = await session.listSessions();
    await session.close();

    expect(events).toContain('subagent.started');
    expect(events).toContain('subagent.completed');
    expect(parentFollowUpContent).toContain('<subagent_run');
    expect(parentFollowUpContent).not.toContain('<task ');
    expect(parentFollowUpContent).not.toContain('task_result');
    expect(sessions.map((item) => item.sessionId)).toEqual([parentId]);
    expect(
      await readFile(
        path.join(
          sessionDir,
          parentId,
          'subagents',
          'run-sidechain.jsonl',
        ),
        'utf8',
      ),
    ).toContain('sub done');
  });

  it('applies primary agent max_turns to the runtime run options', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const target = path.join(cwd, 'loop.txt');
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(target, 'loop\n', 'utf8'),
    );
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'bypass',
      agent: {
        main: {
          mode: 'primary',
          role: 'primary',
          max_turns: 2,
          tools: ['read'],
        },
      },
    });
    const adapter: ModelAdapter = {
      async generate(request) {
        const toolCallMessage = {
          role: 'assistant' as const,
          content: [
            {
              type: 'tool-call',
              toolCallId: `read-${request.messages.length}`,
              toolName: 'read',
              input: { path: target, limit: 10 },
            },
          ],
        };
        return {
          text: '',
          messages: [...request.messages, toolCallMessage],
          newMessages: [toolCallMessage],
          toolCalls: [
            {
              id: `read-${request.messages.length}`,
              name: 'read',
              input: { path: target, limit: 10 },
            },
          ],
          usage,
          finishReason: 'tool-calls',
          provider: null,
        };
      },
      async *stream(request) {
        yield { type: 'final', response: await this.generate(request) };
      },
    };

    const session = await createCodingSession({ config, modelAdapter: adapter });
    const result = await session.submit('loop');
    await session.close();

    expect(result.finishReason).toBe('length');
  });

  it('writes oversized tool output to a session artifact and sends preview to the model', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const target = path.join(cwd, 'big.txt');
    const content = Array.from(
      { length: 20 },
      (_, index) => `line-${index}`,
    ).join('\n');
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(target, content, 'utf8'),
    );
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'default',
      tool_output: {
        max_bytes: 20,
        max_lines: 3,
        preview_lines: 2,
      },
    });

    let turn = 0;
    let secondTurnMessages = '';
    const adapter: ModelAdapter = {
      async generate(request) {
        turn += 1;
        if (turn === 1) {
          const toolCallMessage = {
            role: 'assistant' as const,
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call_read',
                toolName: 'read',
                input: { path: target, limit: 100 },
              },
            ],
          };
          return {
            text: '',
            messages: [...request.messages, toolCallMessage],
            newMessages: [toolCallMessage],
            toolCalls: [
              {
                id: 'call_read',
                name: 'read',
                input: { path: target, limit: 100 },
              },
            ],
            usage,
            finishReason: 'tool-calls',
            provider: null,
          };
        }
        secondTurnMessages = JSON.stringify(request.messages);
        return {
          text: 'done',
          messages: [
            ...request.messages,
            { role: 'assistant', content: 'done' },
          ],
          newMessages: [{ role: 'assistant', content: 'done' }],
          usage,
          finishReason: 'stop',
          provider: null,
        };
      },
      async *stream(request) {
        yield { type: 'final', response: await this.generate(request) };
      },
    };
    const session = await createCodingSession({
      config,
      modelAdapter: adapter,
    });
    const completed: Array<{ output: unknown }> = [];
    session.subscribe((event) => {
      if (event.type === 'tool.completed') {
        completed.push({ output: event.output });
      }
    });

    await session.submit('read big file');
    await session.close();

    const output = completed[0]?.output as {
      metadata?: { outputPath?: string; truncated?: boolean };
    };
    expect(output.metadata?.truncated).toBe(true);
    expect(output.metadata?.outputPath).toBeDefined();
    await expect(access(output.metadata!.outputPath!)).resolves.toBeUndefined();
    expect(secondTurnMessages).toContain('"type":"text"');
    expect(secondTurnMessages).not.toContain('metadata');
  });

  it('applies context tool_result_budget before the next model input', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const target = path.join(cwd, 'big-budget.txt');
    const content = 'x'.repeat(120);
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(target, content, 'utf8'),
    );
    const baseConfig = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'default',
      tool_output: {
        max_bytes: 1000,
        max_lines: 100,
        preview_lines: 100,
      },
    });
    const config = {
      ...baseConfig,
      context: {
        ...baseConfig.context,
        tool_result_budget: {
          enabled: true,
          max_chars: 20,
          artifact_dir: path.join(cwd, '.ello', 'tool-results'),
        },
      },
    };

    let turn = 0;
    let secondTurnMessages = '';
    const adapter: ModelAdapter = {
      async generate(request) {
        turn += 1;
        if (turn === 1) {
          const toolCallMessage = {
            role: 'assistant' as const,
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call_read_budget',
                toolName: 'read',
                input: { path: target, limit: 100 },
              },
            ],
          };
          return {
            text: '',
            messages: [...request.messages, toolCallMessage],
            newMessages: [toolCallMessage],
            toolCalls: [
              {
                id: 'call_read_budget',
                name: 'read',
                input: { path: target, limit: 100 },
              },
            ],
            usage,
            finishReason: 'tool-calls',
            provider: null,
          };
        }
        secondTurnMessages = JSON.stringify(request.messages);
        return {
          text: 'done',
          messages: [
            ...request.messages,
            { role: 'assistant', content: 'done' },
          ],
          newMessages: [{ role: 'assistant', content: 'done' }],
          usage,
          finishReason: 'stop',
          provider: null,
        };
      },
      async *stream(request) {
        yield { type: 'final', response: await this.generate(request) };
      },
    };
    const session = await createCodingSession({
      config,
      modelAdapter: adapter,
    });

    await session.submit('read big file');
    await session.close();

    expect(secondTurnMessages).toContain('tool-output-truncated');
    expect(secondTurnMessages).toContain('.ello/tool-results');
  });

  it('supports session tree checkout and fork from the coding runtime', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'default',
    });
    const session = await createCodingSession({
      config,
      modelAdapter: new TextAdapter('OK'),
    });

    await session.submit('first');
    const tree = await session.sessionTree();
    expect(tree.nodes.length).toBeGreaterThan(0);
    expect(tree.activeEntryId).not.toBeNull();

    const forked = await session.fork('test branch');
    expect(forked).toHaveLength(36);
    expect(
      (await session.listSessions()).map((item) => item.sessionId),
    ).toContain(forked);

    await session.checkout(null);
    expect((await session.sessionTree()).activeEntryId).toBeNull();

    await session.close();
  });

  it('rewinds to a user entry parent and returns the prompt for editing', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'default',
    });
    const session = await createCodingSession({
      config,
      modelAdapter: new TextAdapter('OK'),
    });

    await session.submit('first');
    await session.submit('second');
    const loaded = await new JsonlSessionRepository({ cwd, sessionDir }).load(
      session.sessionId,
    );
    const secondEntryId = loaded.messageEntryIds.find(
      (id, index) => loaded.messages[index]?.content === 'second',
    );
    expect(secondEntryId).toBeDefined();

    const prompt = await session.rewind(secondEntryId!.slice(0, 8));
    const rewound = await new JsonlSessionRepository({ cwd, sessionDir }).load(
      session.sessionId,
    );
    await session.close();

    expect(prompt).toBe('second');
    expect(rewound.messages.map((message) => message.content)).toEqual([
      'first',
      'OK',
    ]);
  });

  it('forks from a target message entry prefix', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'default',
    });
    const session = await createCodingSession({
      config,
      modelAdapter: new TextAdapter('OK'),
    });

    await session.submit('first');
    await session.submit('second');
    const repo = new JsonlSessionRepository({ cwd, sessionDir });
    const loaded = await repo.load(session.sessionId);
    const firstEntryId = loaded.messageEntryIds[0]!;

    const forked = await session.fork(
      'targeted fork',
      firstEntryId.slice(0, 8),
    );
    const forkedSession = await repo.load(forked);
    await session.close();

    expect(forkedSession.messages.map((message) => message.content)).toEqual([
      'first',
    ]);
  });

  it('generates and stores a human-facing session summary', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'default',
    });
    const session = await createCodingSession({
      config,
      modelAdapter: new TextAdapter('summary text'),
    });

    await session.submit('hello');
    const summary = await session.summarize();
    const stored = await new JsonlSessionRepository({
      cwd,
      sessionDir,
    }).latestSummary(session.sessionId);
    await session.close();

    expect(summary).toBe('summary text');
    expect(stored?.summary).toBe('summary text');
  });

  it('exposes titled session summaries for resume browsing', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'default',
    });
    const session = await createCodingSession({
      config,
      modelAdapter: new TextAdapter('OK'),
    });

    await session.submit('hello');
    const sessions = await waitFor(
      () => session.listSessions(),
      (items) => items.some((item) => item.title === 'OK'),
    );
    await session.close();

    expect(sessions.at(0)?.title).toBe('OK');
    expect(sessions.at(0)?.lastUserText).toBeDefined();
    expect(
      sessions.at(0)?.lastAssistantText ?? sessions.at(0)?.lastToolText,
    ).toBeDefined();
  });

  it('sorts resumable sessions by latest conversation time descending', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const repository = new JsonlSessionRepository({ cwd, sessionDir });
    await repository.open('older');
    await repository.appendMessages('older', null, [
      { role: 'user', content: 'older' },
    ]);
    await repository.open('newer');
    await repository.appendMessages('newer', null, [
      { role: 'user', content: 'newer' },
    ]);
    await repository.open('empty');

    const oldDate = new Date('2026-01-01T00:00:00.000Z');
    const newDate = new Date('2026-01-02T00:00:00.000Z');
    const emptyDate = new Date('2026-01-03T00:00:00.000Z');
    await utimes(path.join(sessionDir, 'older.jsonl'), oldDate, oldDate);
    await utimes(path.join(sessionDir, 'newer.jsonl'), newDate, newDate);
    await utimes(path.join(sessionDir, 'empty.jsonl'), emptyDate, emptyDate);

    expect((await repository.list()).map((item) => item.sessionId)).toEqual([
      'newer',
      'older',
    ]);
  });

  it('does not create an empty session when resume target is missing', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'default',
    });
    const session = await createCodingSession({
      config,
      modelAdapter: new TextAdapter('OK'),
    });
    const originalId = session.sessionId;

    await expect(session.resumeSession('missing-session')).rejects.toThrow();
    await expect(
      access(path.join(sessionDir, 'missing-session.jsonl')),
    ).rejects.toThrow();
    expect(session.sessionId).toBe(originalId);
    await session.close();
  });

  it('emits transcript history when resuming a session', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      approvalMode: 'default',
    });
    const session = await createCodingSession({
      config,
      modelAdapter: new TextAdapter('OK'),
    });
    const loaded: number[] = [];
    session.subscribe((event) => {
      if (event.type === 'session.history.loaded') {
        loaded.push(event.messages.length);
      }
    });

    await session.submit('hello');
    const originalId = session.sessionId;
    await session.newSession();
    await session.resumeSession(originalId);
    await session.close();

    expect(loaded.at(-1)).toBeGreaterThan(0);
  });
});
