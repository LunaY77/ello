import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AgentToolContext, ModelAdapter } from '@ello/agent';
import { describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config/index.js';
import {
  defaultRulesetForMode,
  evaluatePermission,
} from '../permission/engine.js';
import { makeApprovalPolicy } from '../permission/policy.js';
import { writePlanArtifact } from '../plan/artifact.js';
import {
  createCodingSession as createCodingSessionRuntime,
  type CreateCodingSessionOptions,
} from '../runtime/coding-session.js';
import { cycleSessionMode, PlanModeError } from '../runtime/session-mode.js';
import { JsonlSessionRepository } from '../session/repository.js';
import { handleSlashCommand } from '../slash-commands.js';

function createCodingSession(
  options: Omit<CreateCodingSessionOptions, 'clientCapabilities'>,
) {
  return createCodingSessionRuntime({
    ...options,
    clientCapabilities: { requestUserInput: false },
  });
}

const usage = {
  requests: 1,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  toolCalls: 0,
};

const adapter: ModelAdapter = {
  async generate(request) {
    return {
      text: 'done',
      messages: [...request.messages, { role: 'assistant', content: 'done' }],
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

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ello-plan-'));
}

describe('Plan mode', () => {
  it('cycles only through enabled modes and seals plan permissions', () => {
    expect(cycleSessionMode('default', 'next', false)).toBe('accept-edits');
    expect(cycleSessionMode('accept-edits', 'next', false)).toBe('plan');
    expect(cycleSessionMode('plan', 'next', false)).toBe('default');
    const rules = defaultRulesetForMode('plan');
    expect(evaluatePermission(rules, 'read', '**')).toBe('allow');
    expect(evaluatePermission(rules, 'edit', '**')).toBe('deny');
    expect(evaluatePermission(rules, 'bash', '**')).toBe('deny');
    expect(evaluatePermission(rules, 'web_fetch', '**')).toBe('deny');
  });

  it('applies the current session mode as the permission boundary', async () => {
    const cwd = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      tools: {
        disabled: [],
        needApproval: ['write', 'bash'],
        routing_enabled: false,
        search: { result_limit: 6, max_result_bytes: 24_000 },
      },
    });
    let mode = config.initialMode;
    const decide = makeApprovalPolicy(
      config,
      () => [],
      () => ({
        mode,
        previousMode: null,
        source: 'shortcut',
        changedAt: new Date(0).toISOString(),
      }),
    );
    const edit = {
      permission: 'edit',
      patterns: ['note.txt'],
      always: ['note.txt'],
      metadata: {
        kind: 'edit' as const,
        path: path.join(cwd, 'note.txt'),
        fileChanges: [],
      },
    };
    const bash = {
      permission: 'bash',
      patterns: ['echo ok'],
      always: ['echo ok'],
      metadata: {
        kind: 'shell' as const,
        command: 'echo ok',
        cwd,
      },
    };
    const context = {} as AgentToolContext;

    expect(decide(edit, context)).toMatchObject({ action: 'required' });
    mode = 'accept-edits';
    expect(decide(edit, context)).toBe('auto');
    expect(decide(bash, context)).toMatchObject({ action: 'required' });
    mode = 'plan';
    expect(decide(edit, context)).toMatchObject({ action: 'denied' });
    mode = 'bypass';
    expect(decide(edit, context)).toBe('auto');
    expect(decide(bash, context)).toBe('auto');
  });

  it('preserves raw slash command input', async () => {
    const config = await loadCodingAgentConfig({ cwd: await tempDir() });
    expect(
      handleSlashCommand('/plan   inspect  exact spacing  ', config).command,
    ).toEqual({
      type: 'plan-command',
      command: { kind: 'with-input', input: 'inspect  exact spacing' },
    });
  });

  it('accepts a plan once and starts a default execution session', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      initialMode: 'plan',
    });
    const session = await createCodingSession({
      config,
      modelAdapter: adapter,
    });
    const planSessionId = session.sessionId;
    const artifact = await writePlanArtifact({
      cwd,
      sessionId: planSessionId,
      content: '# Implementation\n\n1. Change the parser.',
    });
    const repository = new JsonlSessionRepository({ cwd, sessionDir });
    const now = new Date().toISOString();
    await repository.appendPlanState(planSessionId, 'plan.created', {
      status: 'draft',
      sessionId: planSessionId,
      contentHash: artifact.contentHash,
      createdAt: now,
      updatedAt: now,
    });
    let requestId = '';
    session.subscribe((event) => {
      if (event.type === 'plan.approval.requested')
        requestId = event.plan.requestId;
    });

    await session.requestPlanExit();
    const first = await session.acceptPlan(requestId, artifact.contentHash);
    const repeated = await session.acceptPlan(requestId, artifact.contentHash);

    expect(repeated).toEqual(first);
    expect(session.sessionId).toBe(first.executionSessionId);
    expect(session.mode().mode).toBe('default');
    const execution = await repository.load(first.executionSessionId);
    expect(execution.messages[0]).toMatchObject({
      role: 'user',
      content: artifact.content,
    });
    await session.close();
  });

  it('rejects bypass when the safety switch is disabled', async () => {
    const config = await loadCodingAgentConfig({
      cwd: await tempDir(),
      sessionDir: await tempDir(),
    });
    const session = await createCodingSession({
      config,
      modelAdapter: adapter,
    });
    await expect(session.setMode('bypass', 'shortcut')).rejects.toMatchObject<
      Partial<PlanModeError>
    >({
      code: 'MODE_NOT_ALLOWED',
      sessionId: session.sessionId,
    });
    await session.close();
  });

  it('stops requesting approvals after the session switches to bypass', async () => {
    const cwd = await tempDir();
    const sessionDir = await tempDir();
    const target = path.join(cwd, 'bypass.txt');
    let turn = 0;
    const bypassAdapter: ModelAdapter = {
      async generate(request) {
        turn += 1;
        if (turn === 1) {
          const toolCall = {
            id: 'call_write',
            name: 'write',
            input: { path: target, content: 'bypassed' },
          };
          const toolCallMessage = {
            role: 'assistant' as const,
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                input: toolCall.input,
              },
            ],
          };
          return {
            text: '',
            messages: [...request.messages, toolCallMessage],
            newMessages: [toolCallMessage],
            toolCalls: [toolCall],
            usage,
            finishReason: 'tool-calls' as const,
            provider: null,
          };
        }
        return adapter.generate(request);
      },
      async *stream(request) {
        yield { type: 'final', response: await this.generate(request) };
      },
    };
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      bypassEnabled: true,
      tools: {
        disabled: [],
        needApproval: ['write'],
        routing_enabled: false,
        search: { result_limit: 6, max_result_bytes: 24_000 },
      },
    });
    const session = await createCodingSession({
      config,
      modelAdapter: bypassAdapter,
    });
    let approvals = 0;
    session.subscribe((event) => {
      if (event.type === 'approval.pending') approvals += 1;
    });

    await session.setMode('bypass', 'shortcut');
    await session.submit('write without approval');

    expect(session.mode().mode).toBe('bypass');
    expect(approvals).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('bypassed');
    await session.close();
  });
});
