import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PermissionRule } from '../../src/agent/permissions/types.js';
import {
  BackgroundJobStore,
  createAgentRegistry,
  deriveSubagentPermission,
  type CodingAgentDefinition,
} from '../../src/agent/subagents/index.js';
import type { CodingAgentConfig } from '../../src/config/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createRegistry(
  agent: CodingAgentConfig['agent'] = {},
): ReturnType<typeof createAgentRegistry> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ello-subagent-contract-'));
  temporaryDirectories.push(cwd);
  return createAgentRegistry({ cwd, agent } as CodingAgentConfig);
}

const subagentDefinition: CodingAgentDefinition = {
  name: 'tester',
  mode: 'subagent',
  role: 'small',
  description: '测试代理',
  source: 'builtin',
};

describe('Subagent 注册与隔离契约', () => {
  it('仅向主代理选择器和委派选择器暴露各自允许的非隐藏代理', async () => {
    const registry = await createRegistry();

    expect(registry.selectablePrimaries().map((agent) => agent.name)).toContain(
      'build',
    );
    expect(
      registry.selectablePrimaries().map((agent) => agent.name),
    ).not.toContain('explore');
    expect(registry.delegatable().map((agent) => agent.name)).toContain(
      'explore',
    );
    expect(registry.delegatable().map((agent) => agent.name)).not.toContain(
      'build',
    );
    expect(registry.list().some((agent) => agent.mode === 'internal')).toBe(
      true,
    );
    expect(() => registry.get('不存在')).toThrow('Unknown agent');
  });

  it('项目 Markdown 代理覆盖同名内置代理并保留完整业务定义', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ello-subagent-override-'));
    temporaryDirectories.push(cwd);
    const agentsDirectory = path.join(cwd, '.ello', 'agents');
    await mkdir(agentsDirectory, { recursive: true });
    await writeFile(
      path.join(agentsDirectory, 'explore.md'),
      `---
description: 项目专用探索代理
mode: subagent
role: primary
tools:
  - read
  - grep
---

只读取并分析项目。
`,
      'utf8',
    );

    const registry = await createAgentRegistry({
      cwd,
      agent: {},
    } as CodingAgentConfig);

    expect(registry.get('explore')).toMatchObject({
      source: 'project',
      description: '项目专用探索代理',
      role: 'primary',
      tools: ['read', 'grep'],
      prompt: '只读取并分析项目。',
    });
  });

  it('配置代理可被发现且损坏的 Markdown 定义使加载明确失败', async () => {
    const registry = await createRegistry({
      reviewer: {
        mode: 'subagent',
        role: 'review',
        description: '代码审查',
      },
    });
    expect(registry.get('reviewer')).toMatchObject({
      source: 'config',
      description: '代码审查',
      role: 'review',
    });

    const cwd = await mkdtemp(path.join(tmpdir(), 'ello-subagent-invalid-'));
    temporaryDirectories.push(cwd);
    const agentsDirectory = path.join(cwd, '.ello', 'agents');
    await mkdir(agentsDirectory, { recursive: true });
    await writeFile(
      path.join(agentsDirectory, 'invalid.md'),
      `---
description: 损坏的代理
unknown-field: true
---

正文
`,
      'utf8',
    );

    await expect(
      createAgentRegistry({ cwd, agent: {} } as CodingAgentConfig),
    ).rejects.toThrow('Unrecognized key');
  });

  it('子代理仅继承父级拒绝和外部目录边界，不继承父级允许', () => {
    const parentRules: PermissionRule[] = [
      {
        permission: 'read',
        pattern: '**',
        action: 'allow',
        scope: 'session',
      },
      {
        permission: 'bash',
        pattern: '**',
        action: 'deny',
        scope: 'session',
        reason: '禁止 Shell',
      },
      {
        permission: 'external_directory',
        pattern: '/tmp/**',
        action: 'allow',
        scope: 'session',
      },
    ];

    const rules = deriveSubagentPermission(parentRules, subagentDefinition);

    expect(rules).not.toContainEqual(parentRules[0]);
    expect(rules).toContainEqual(parentRules[1]);
    expect(rules).toContainEqual(parentRules[2]);
  });

  it('默认禁止递归委派和任务写入，显式白名单可分别放开', () => {
    const defaults = deriveSubagentPermission([], subagentDefinition);
    expect(defaults).toContainEqual(
      expect.objectContaining({
        pattern: 'delegate_to_subagent',
        action: 'deny',
      }),
    );
    expect(defaults).toContainEqual(
      expect.objectContaining({ pattern: 'task_create', action: 'deny' }),
    );

    const delegated = deriveSubagentPermission([], {
      ...subagentDefinition,
      tools: ['delegate_to_subagent'],
    });
    expect(
      delegated.some((rule) => rule.pattern === 'delegate_to_subagent'),
    ).toBe(false);

    const tasked = deriveSubagentPermission([], {
      ...subagentDefinition,
      tools: ['task_list'],
    });
    expect(tasked.some((rule) => rule.permission === 'task')).toBe(false);
  });
});

describe('Subagent 后台任务契约', () => {
  it('完成和失败都形成可查询终态并通知订阅方', async () => {
    const store = new BackgroundJobStore();
    const listener = vi.fn();
    store.onSettled(listener);

    const completed = Promise.resolve('分析完成');
    const failed = Promise.reject(new Error('模型失败'));
    store.start(
      {
        id: 'completed',
        parentSessionId: 'parent-a',
        agentName: 'explore',
        title: '分析',
      },
      { final: completed, abort: vi.fn() },
    );
    store.start(
      {
        id: 'failed',
        parentSessionId: 'parent-a',
        agentName: 'review',
        title: '审查',
      },
      { final: failed, abort: vi.fn() },
    );

    await Promise.allSettled([completed, failed]);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(store.get('completed')).toMatchObject({
      status: 'completed',
      output: '分析完成',
    });
    expect(store.get('failed')).toMatchObject({
      status: 'error',
      error: '模型失败',
    });
  });

  it('取消仅影响运行中任务并按父会话隔离查询', () => {
    const store = new BackgroundJobStore();
    const abort = vi.fn();
    store.start(
      {
        id: 'job-a',
        parentSessionId: 'parent-a',
        agentName: 'explore',
        title: 'A',
      },
      { final: new Promise(() => undefined), abort },
    );
    store.start(
      {
        id: 'job-b',
        parentSessionId: 'parent-b',
        agentName: 'explore',
        title: 'B',
      },
      { final: new Promise(() => undefined), abort: vi.fn() },
    );

    expect(store.list('parent-a').map((job) => job.id)).toEqual(['job-a']);
    store.cancel('job-a');
    store.cancel('job-a');

    expect(abort).toHaveBeenCalledTimes(1);
    expect(store.get('job-a')?.status).toBe('cancelled');
    expect(store.get('job-b')?.status).toBe('running');
  });
});
