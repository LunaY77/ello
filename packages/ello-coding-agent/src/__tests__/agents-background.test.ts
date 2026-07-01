import { describe, expect, it, vi } from 'vitest';

import {
  BackgroundJobStore,
  deriveSubagentPermission,
  type CodingAgentDefinition,
} from '../agents/index.js';
import type { PermissionRule } from '../permissions.js';

describe('BackgroundJobStore', () => {
  it('start creates a running job', () => {
    const store = new BackgroundJobStore();
    const job = store.start(
      { id: 'j1', parentSessionId: 'p1', agentName: 'explore', title: 'Test' },
      { final: new Promise(() => {}), abort: () => {} },
    );
    expect(job.status).toBe('running');
    expect(store.get('j1')?.status).toBe('running');
  });

  it('settles on completion', async () => {
    const store = new BackgroundJobStore();
    const settled = vi.fn();
    store.onSettled(settled);
    let resolve!: (v: string) => void;
    const final = new Promise<string>((r) => {
      resolve = r;
    });
    store.start(
      { id: 'j2', parentSessionId: 'p1', agentName: 'explore', title: 'Test' },
      { final, abort: () => {} },
    );
    resolve('done');
    await final;
    await new Promise((r) => setTimeout(r, 10));
    expect(store.get('j2')?.status).toBe('completed');
    expect(store.get('j2')?.output).toBe('done');
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('cancel marks cancelled and calls abort', () => {
    const store = new BackgroundJobStore();
    const abort = vi.fn();
    store.start(
      { id: 'j3', parentSessionId: 'p1', agentName: 'explore', title: 'Test' },
      { final: new Promise(() => {}), abort },
    );
    store.cancel('j3');
    expect(store.get('j3')?.status).toBe('cancelled');
    expect(abort).toHaveBeenCalled();
  });

  it('list filters by parentSessionId', () => {
    const store = new BackgroundJobStore();
    store.start(
      { id: 'a', parentSessionId: 'p1', agentName: 'x', title: 'A' },
      { final: new Promise(() => {}), abort: () => {} },
    );
    store.start(
      { id: 'b', parentSessionId: 'p2', agentName: 'x', title: 'B' },
      { final: new Promise(() => {}), abort: () => {} },
    );
    expect(store.list('p1')).toHaveLength(1);
    expect(store.list()).toHaveLength(2);
  });
});

describe('deriveSubagentPermission', () => {
  const parentRules: PermissionRule[] = [
    { action: 'allow', tool: 'read', scope: 'session' },
    { action: 'deny', tool: 'bash', scope: 'session', reason: 'no shell' },
  ];

  const baseDef: CodingAgentDefinition = {
    name: 'test',
    mode: 'subagent',
    role: 'small',
    description: 'test',
    source: 'builtin',
  };

  it('only inherits deny from parent', () => {
    const rules = deriveSubagentPermission(parentRules, baseDef);
    expect(rules.some((r) => r.action === 'allow' && r.tool === 'read')).toBe(
      false,
    );
    expect(rules.some((r) => r.action === 'deny' && r.tool === 'bash')).toBe(
      true,
    );
  });

  it('default-denies delegate_to_subagent and task tools', () => {
    const rules = deriveSubagentPermission([], baseDef);
    expect(rules.some((r) => r.tool === 'delegate_to_subagent')).toBe(true);
    expect(rules.some((r) => r.tool === 'task_create')).toBe(true);
  });

  it('allows delegate if tools whitelist includes it', () => {
    const def = {
      ...baseDef,
      tools: ['delegate_to_subagent', 'read'] as const,
    };
    const rules = deriveSubagentPermission([], def);
    expect(rules.some((r) => r.tool === 'delegate_to_subagent')).toBe(false);
  });

  it('allows task tools if tools whitelist starts with task_', () => {
    const def = { ...baseDef, tools: ['task_create', 'task_list'] as const };
    const rules = deriveSubagentPermission([], def);
    expect(
      rules.some((r) => r.tool === 'task_create' && r.action === 'deny'),
    ).toBe(false);
  });
});
