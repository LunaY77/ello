/**
 * 本文件验证 subagent 报告进入主线程时附带的消费契约。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentTaskService,
  AgentTaskStore,
  type CreateAgentTask,
} from '../../src/features/agent/subagents/index.js';
import {
  openDatabase,
  type DatabaseHandle,
} from '../../src/infra/database/index.js';

const roots: string[] = [];
const handles: DatabaseHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('subagent report contract', () => {
  it.each([
    ['explore', 'read-only exploration agent'],
    ['worker', 'implementation agent'],
  ])('为 %s 报告追加对应消费指令', async (definitionName, marker) => {
    const { service, store } = await fixture();
    const task = store.create(taskInput(definitionName));
    store.settle(task.id, { status: 'completed', output: 'report body' });

    const notification = service.takeNotifications(task.rootThreadId);

    expect(notification).toContain('<how-to-consume>');
    expect(notification).toContain(marker);
    expect(notification.indexOf('<how-to-consume>')).toBeGreaterThan(
      notification.indexOf('<result>'),
    );
  });

  it('未知 definition 只追加通用消费契约', async () => {
    const { service, store } = await fixture();
    const task = store.create(taskInput('custom-agent'));
    store.settle(task.id, { status: 'completed', output: 'custom report' });

    const notification = service.takeNotifications(task.rootThreadId);

    expect(notification).toContain('A subagent report is evidence');
    expect(notification).not.toContain('read-only exploration agent');
    expect(notification).not.toContain('implementation agent');
  });
});

async function fixture(): Promise<{
  readonly service: AgentTaskService;
  readonly store: AgentTaskStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-report-contract-'));
  roots.push(root);
  const handle = openDatabase({
    databasePath: path.join(root, 'state.sqlite'),
  });
  handles.push(handle);
  const store = new AgentTaskStore(handle.db);
  return {
    store,
    service: new AgentTaskService(store, () =>
      Promise.reject(new Error('Report contract test does not launch tasks.')),
    ),
  };
}

function taskInput(definitionName: string): CreateAgentTask {
  return {
    rootThreadId: `root-${definitionName}`,
    description: 'test report contract',
    definitionName,
    contextMode: 'fresh',
    executionMode: 'background',
    prompt: 'inspect',
    cwd: '/workspace',
    isolation: 'shared',
    maxTurns: 1,
    depth: 1,
    sidechain: [],
    toolNames: [],
    permissionRules: [],
    externalPaths: [],
  };
}
