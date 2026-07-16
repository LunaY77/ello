import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ModelAdapter } from '@ello/agent';
import { describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config/index.js';
import {
  defaultRulesetForMode,
  evaluatePermission,
} from '../permission/engine.js';
import { writePlanArtifact } from '../plan/artifact.js';
import { createCodingSession } from '../runtime/coding-session.js';
import { cycleSessionMode, PlanModeError } from '../runtime/session-mode.js';
import { JsonlSessionRepository } from '../session/repository.js';
import { handleSlashCommand } from '../slash-commands.js';

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
});
