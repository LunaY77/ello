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

const routedTools = {
  disabled: [],
  needApproval: [],
  routing_enabled: true,
  search: { result_limit: 6, max_result_bytes: 24_000 },
} as const;

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

function toolCallResponse(
  request: AgentModelRequest,
  call: { readonly id: string; readonly name: string; readonly input: unknown },
): AgentModelResponse {
  const message = {
    role: 'assistant' as const,
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
      },
    ],
  };
  return {
    text: '',
    messages: [...request.messages, message],
    newMessages: [message],
    toolCalls: [call],
    usage,
    finishReason: 'tool-calls',
    provider: null,
  };
}

function latestToolResult(request: AgentModelRequest): string {
  const message = [...request.messages]
    .reverse()
    .find((candidate) => candidate.role === 'tool');
  if (message === undefined) {
    throw new Error('Expected a tool result in the model request.');
  }
  return JSON.stringify(message);
}

describe('goal continuation runtime', () => {
  it('only exposes goal tools while a session goal is active', async () => {
    const cwd = await temporaryDirectory('ello-goal-tools-cwd-');
    const sessionDir = await temporaryDirectory('ello-goal-tools-session-');
    const searchResults: string[] = [];
    const toolsets: string[][] = [];
    const fingerprints = new Set<string>();
    let stage = 0;
    const adapter: ModelAdapter = {
      async generate(request) {
        if (!(request.system ?? '').includes('# Primary Agent Role')) {
          return textResponse(request, 'Goal tools test');
        }
        toolsets.push(Object.keys(request.tools).sort());
        if (stage === 0 || stage === 2 || stage === 5) {
          const id = `goal-search-${stage}`;
          stage += 1;
          return toolCallResponse(request, {
            id,
            name: 'tool_search',
            input: { query: 'goal status update', limit: 6 },
          });
        }
        if (stage === 1) {
          searchResults.push(latestToolResult(request));
          stage = 2;
          return textResponse(request, 'Ordinary request complete.');
        }
        if (stage === 3) {
          searchResults.push(latestToolResult(request));
          stage = 4;
          return toolCallResponse(request, {
            id: 'complete-active-goal',
            name: 'call_tool',
            input: {
              name: 'update_goal',
              arguments: {
                status: 'complete',
                reason: 'active goal verification is complete',
              },
            },
          });
        }
        if (stage === 4) {
          stage = 5;
          return textResponse(request, 'Active goal complete.');
        }
        if (stage === 6) {
          searchResults.push(latestToolResult(request));
          stage = 7;
          return textResponse(request, 'Post-goal request complete.');
        }
        throw new Error(`Unexpected goal tool test stage: ${stage}`);
      },
      async *stream(request) {
        yield {
          type: 'final' as const,
          response: await this.generate(request),
        };
      },
    };
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      tools: routedTools,
    });
    const session = await createCodingSession({
      config,
      modelAdapter: adapter,
    });
    session.subscribe((event) => {
      if (event.type === 'model.completed') {
        fingerprints.add(event.diagnostics.toolsetFingerprint);
      }
    });

    await session.submit('finish an ordinary task');
    await session.createGoal('verify active goal tools');
    await session.submit('finish another ordinary task');
    await session.close();

    expect(stage).toBe(7);
    expect(searchResults).toHaveLength(3);
    expect(searchResults[0]).not.toContain('update_goal');
    expect(searchResults[1]).toContain('update_goal');
    expect(searchResults[1]).toContain('get_goal');
    expect(searchResults[2]).not.toContain('update_goal');
    expect(toolsets).toEqual(toolsets.map(() => ['call_tool', 'tool_search']));
    expect(fingerprints.size).toBe(1);
  });

  it('recovers when a final answer omits update_goal and stops after the explicit update', async () => {
    const cwd = await temporaryDirectory('ello-goal-runtime-cwd-');
    const sessionDir = await temporaryDirectory('ello-goal-runtime-session-');
    const systems: string[] = [];
    let primaryCalls = 0;
    const adapter: ModelAdapter = {
      async generate(request) {
        if (!(request.system ?? '').includes('# Primary Agent Role')) {
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
                toolName: 'call_tool',
                input: {
                  name: 'update_goal',
                  arguments: {
                    status: 'complete',
                    reason: 'implementation and verification are complete',
                  },
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
                name: 'call_tool',
                input: {
                  name: 'update_goal',
                  arguments: {
                    status: 'complete',
                    reason: 'implementation and verification are complete',
                  },
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
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      tools: routedTools,
    });
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
