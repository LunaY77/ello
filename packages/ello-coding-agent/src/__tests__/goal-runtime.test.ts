import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

const usage = {
  requests: 1,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 80,
  cacheWriteTokens: 0,
  toolCalls: 0,
};

function textResponse(
  request: AgentModelRequest,
  text: string,
): AgentModelResponse {
  const message = { role: 'assistant' as const, content: text };
  return {
    text,
    messages: [...request.messages, message],
    newMessages: [message],
    usage,
    finishReason: 'stop',
    provider: null,
  };
}

describe('goal continuation runtime', () => {
  it('recovers when a final answer omits update_goal and stops after the explicit update', async () => {
    const cwd = await temporaryDirectory('ello-goal-runtime-cwd-');
    const sessionDir = await temporaryDirectory('ello-goal-runtime-session-');
    const systems: string[] = [];
    let primaryCalls = 0;
    const adapter: ModelAdapter = {
      async generate(request) {
        if (!Object.hasOwn(request.tools, 'update_goal')) {
          return textResponse(request, 'Goal runtime test');
        }
        primaryCalls += 1;
        systems.push(request.system ?? '');
        if (primaryCalls === 1) {
          return textResponse(request, 'I started but have more work to do.');
        }
        if (primaryCalls === 2) {
          return textResponse(
            request,
            'Final architecture summary without a goal state update.',
          );
        }
        if (primaryCalls === 3) {
          const toolCallMessage = {
            role: 'assistant' as const,
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'goal-complete',
                toolName: 'update_goal',
                input: {
                  status: 'complete',
                  reason: 'implementation and verification are complete',
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
                id: 'goal-complete',
                name: 'update_goal',
                input: {
                  status: 'complete',
                  reason: 'implementation and verification are complete',
                },
              },
            ],
            usage,
            finishReason: 'tool-calls',
            provider: null,
          };
        }
        return textResponse(request, 'The goal is complete.');
      },
      async *stream(
        request: AgentModelRequest,
      ): AsyncIterable<AgentModelEvent> {
        yield { type: 'final', response: await this.generate(request) };
      },
    };
    const config = await loadCodingAgentConfig({ cwd, sessionDir });
    const session = await createCodingSession({
      config,
      modelAdapter: adapter,
    });

    await session.createGoal('finish the goal');
    await session.waitForGoalContinuation();
    const sessionId = session.sessionId;
    const status = session.goalStatus();
    await session.close();

    const records = (
      await readFile(path.join(sessionDir, `${sessionId}.jsonl`), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const userEntries = records.filter(
      (record) =>
        record.kind === 'entry' &&
        (record.message as { role?: unknown }).role === 'user',
    );

    expect(primaryCalls).toBe(4);
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.message).toMatchObject({
      role: 'user',
      content: 'finish the goal',
    });
    expect(systems[0]).toContain('ello goal controller is now active');
    expect(systems[0]).toContain(
      'Producing a final answer does not complete or clear the goal.',
    );
    expect(systems[0]).not.toContain('It auto-clears');
    expect(systems[1]).toContain(
      'Continue working toward the active thread goal',
    );
    expect(systems[1]).toContain(
      'Producing or repeating a final answer does not update the host goal state.',
    );
    expect(status).toMatchObject({
      status: 'complete',
      continuationTurns: 2,
      tokensUsed: 160,
    });
  });
});
