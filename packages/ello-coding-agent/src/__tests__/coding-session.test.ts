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

import { loadCodingAgentConfig } from '../config.js';
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
      model: 'fake:test',
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

  it('defers write tools for approval and resumes after approve_once', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      model: 'fake:test',
      approvalMode: 'default',
    });

    const target = path.join(cwd, 'note.txt');
    let turn = 0;
    const adapter: ModelAdapter = {
      async generate(request) {
        turn += 1;
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
  });
});
