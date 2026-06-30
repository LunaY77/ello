import { mkdtemp, rm } from 'node:fs/promises';
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
          return {
            text: '',
            messages: [...request.messages],
            newMessages: [],
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
    const pending: { requestId: string; toolName: string }[] = [];
    session.subscribe((event) => {
      if (event.type === 'approval.pending') {
        pending.push({ requestId: event.requestId, toolName: event.toolName });
      }
    });

    await session.submit('write a note');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolName).toBe('write');

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

    await session.checkout(null);
    expect((await session.sessionTree()).activeEntryId).toBeNull();

    const forked = await session.fork('test branch');
    expect(forked).toHaveLength(36);
    expect(
      (await session.listSessions()).map((item) => item.sessionId),
    ).toContain(forked);

    await session.close();
  });

  it('exposes session summaries with last message previews for resume browsing', async () => {
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
    const sessions = await session.listSessions();
    await session.close();

    expect(sessions.at(0)?.lastUserText).toBeDefined();
    expect(
      sessions.at(0)?.lastAssistantText ?? sessions.at(0)?.lastToolText,
    ).toBeDefined();
  });
});
