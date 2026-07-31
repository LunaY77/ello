/**
 * 本文件验证 subagent-contract 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentRun,
  AgentRunEvent,
  AgentRunResult,
  AgentRunRequest,
  ResolvedAgentDefinition,
} from '../../src/features/agent/index.js';
import {
  AgentTaskService,
  AgentTaskStore,
  AgentTaskRpcFeature,
  createAgentRegistry,
  createAgentTaskEventPreparer,
  createSubagentTools,
  deriveSubagentPermission,
  type CreateAgentTask,
  type CodingAgentDefinition,
} from '../../src/features/agent/subagents/index.js';
import { ArtifactStore } from '../../src/features/artifact/index.js';
import {
  AgentConfigSchema,
  SubagentsConfigSchema,
  type CodingAgentConfig,
} from '../../src/features/config/index.js';
import type { PermissionRule } from '../../src/features/tool/permissions/types.js';
import {
  openDatabase,
  type DatabaseHandle,
} from '../../src/infra/database/index.js';
import type { ServerNotification } from '../../src/protocol/v1/index.js';
import { createTestEnvironmentHandle } from '../support/environment.js';
import { createTestPeer, invokeServiceRoute } from '../support/rpc.js';

const temporaryDirectories: string[] = [];
const databaseHandles: DatabaseHandle[] = [];
const taskServices: AgentTaskService[] = [];

afterEach(async () => {
  await Promise.all(taskServices.splice(0).map((service) => service.close()));
  for (const handle of databaseHandles.splice(0)) handle.close();
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
  return createAgentRegistry({
    cwd,
    agent,
    subagents: enabledSubagents,
  } as CodingAgentConfig);
}

const enabledSubagents = {
  enabled: true,
  cwd_policy: 'allowed_paths',
} as const;

const subagentDefinition: CodingAgentDefinition = {
  name: 'tester',
  mode: 'subagent',
  model: 'auxiliary_model',
  description: '测试代理',
  source: 'builtin',
  maxTurns: 4,
};

describe('Subagent 注册与隔离契约', () => {
  it('配置 schema 仅接受正整数或 -1 作为回合上限', () => {
    expect(
      AgentConfigSchema.parse({
        model: 'auxiliary_model',
        max_turns: -1,
      }).max_turns,
    ).toBe(-1);
    expect(
      AgentConfigSchema.safeParse({
        model: 'auxiliary_model',
        max_turns: -2,
      }).success,
    ).toBe(false);
  });

  it('subagent 开关默认启用且允许显式关闭', () => {
    expect(SubagentsConfigSchema.parse({})).toEqual({
      enabled: true,
      cwd_policy: 'allowed_paths',
    });
    expect(SubagentsConfigSchema.parse({ enabled: false }).enabled).toBe(false);
  });

  it('仅向主代理选择器和委派选择器暴露各自允许的非隐藏代理', async () => {
    const registry = await createRegistry();

    expect(registry.selectablePrimaries().map((agent) => agent.name)).toContain(
      'build',
    );
    expect(registry.get('build').maxTurns).toBeUndefined();
    expect(
      registry.selectablePrimaries().map((agent) => agent.name),
    ).not.toContain('explore');
    expect(registry.get('explore').maxTurns).toBe(-1);
    expect(registry.get('worker')).toMatchObject({
      model: 'primary_model',
      maxTurns: -1,
      source: 'bundled',
    });
    expect(registry.delegatable().map((agent) => agent.name)).toEqual(
      expect.arrayContaining(['explore', 'worker']),
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
model: primary_model
max-turns: 6
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
      subagents: enabledSubagents,
    } as CodingAgentConfig);

    expect(registry.get('explore')).toMatchObject({
      source: 'project',
      description: '项目专用探索代理',
      model: 'primary_model',
      tools: ['read', 'grep'],
      prompt: '只读取并分析项目。',
    });
  });

  it('配置代理可被发现且损坏的 Markdown 定义使加载明确失败', async () => {
    const registry = await createRegistry({
      reviewer: {
        mode: 'subagent',
        model: 'primary_model',
        description: '代码审查',
        max_turns: 8,
      },
    });
    expect(registry.get('reviewer')).toMatchObject({
      source: 'config',
      description: '代码审查',
      model: 'primary_model',
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
      createAgentRegistry({
        cwd,
        agent: {},
        subagents: enabledSubagents,
      } as CodingAgentConfig),
    ).rejects.toThrow('Unrecognized key');
  });

  it('关闭 subagent 时 registry 不暴露委派候选且不注册控制工具', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ello-subagent-disabled-'));
    temporaryDirectories.push(cwd);
    const config = {
      cwd,
      agent: {},
      subagents: { enabled: false, cwd_policy: 'allowed_paths' },
    } as CodingAgentConfig;
    const registry = await createAgentRegistry(config);

    expect(registry.delegatable()).toEqual([]);
    expect(
      createSubagentTools({
        request: parentRequest(cwd),
        definition: {
          config,
          definition: registry.get('build'),
          agentRegistry: registry,
        },
        parentToolNames: [],
        service: {} as AgentTaskService,
        approval: () => () => ({ action: 'auto' }),
      }),
    ).toEqual([]);
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
  it('委派工具把当前 registry 候选暴露为严格枚举和可读目录', async () => {
    const registry = await createRegistry();
    const request: AgentRunRequest = {
      threadId: 'parent-a',
      turnId: 'turn-parent',
      executionLocation: {
        environmentRef: 'test',
        workingDirectory: '/workspace',
      },
      selection: { mode: 'accept-edits', agent: 'build' },
      history: [],
      input: '列出可用子代理',
      goal: null,
      permission: { rules: () => [], externalPaths: () => [] },
    };
    const tools = createSubagentTools({
      request,
      definition: {
        config: {
          cwd: '/workspace',
          subagents: enabledSubagents,
        } as CodingAgentConfig,
        definition: registry.get('build'),
        agentRegistry: registry,
      },
      parentToolNames: [],
      service: {} as AgentTaskService,
      approval: () => () => ({ action: 'auto' }),
    });
    const delegate = tools.find((tool) => tool.name === 'delegate_to_subagent');
    const taskOutput = tools.find((tool) => tool.name === 'task_output');
    if (delegate === undefined) throw new Error('主代理缺少委派工具。');
    if (taskOutput === undefined) throw new Error('主代理缺少任务输出工具。');

    expect(delegate.description).toContain('Available subagents:');
    expect(delegate.description).toContain('- explore:');
    expect(delegate.description).toContain('- worker:');
    expect(
      delegate.input.safeParse({
        subagent_type: '不存在',
        prompt: '检查代码',
        description: '检查代码',
      }).success,
    ).toBe(false);
    expect(
      delegate.input.safeParse({
        subagent_type: 'explore',
        prompt: '检查代码',
        description: '检查代码',
      }).success,
    ).toBe(true);
    expect(
      taskOutput.input.safeParse({
        task_id: 'job_test',
        block: true,
        timeout_ms: 180_000,
      }).success,
    ).toBe(true);
    expect(
      taskOutput.input.safeParse({
        task_id: 'job_test',
        block: true,
        timeout_ms: 180_001,
      }).success,
    ).toBe(false);
  });

  it('fork 保留父级委派工具 schema，但默认深度明确拒绝递归', async () => {
    const registry = await createRegistry();
    const request: AgentRunRequest = {
      threadId: 'job_parent',
      turnId: 'turn-parent',
      executionLocation: {
        environmentRef: 'test',
        workingDirectory: '/workspace',
      },
      selection: { mode: 'accept-edits', agent: 'explore' },
      history: [],
      input: '继续探索',
      goal: null,
      permission: { rules: () => [], externalPaths: () => [] },
      delegation: {
        taskId: 'job_parent',
        agentId: 'agent_parent',
        rootThreadId: 'parent-a',
        depth: 1,
        contextMode: 'fork',
        executionMode: 'background',
        maxTurns: 4,
        exactToolNames: [
          'read',
          'delegate_to_subagent',
          'task_output',
          'task_stop',
        ],
      },
    };
    const definition: ResolvedAgentDefinition = {
      config: {
        cwd: '/workspace',
        subagents: enabledSubagents,
      } as CodingAgentConfig,
      definition: registry.get('explore'),
      agentRegistry: registry,
    };
    const tools = createSubagentTools({
      request,
      definition,
      parentToolNames: request.delegation!.exactToolNames!,
      service: {} as AgentTaskService,
      approval: () => () => ({ action: 'auto' }),
    });
    const delegate = tools.find((tool) => tool.name === 'delegate_to_subagent');

    expect(tools.map((tool) => tool.name)).toEqual([
      'delegate_to_subagent',
      'task_output',
      'task_stop',
    ]);
    if (delegate === undefined || !('execute' in delegate)) {
      throw new Error('fork 缺少可执行的委派工具 schema。');
    }
    await expect(
      delegate.execute(
        {
          subagent_type: 'explore',
          prompt: '继续递归',
          description: '递归探索',
          context_mode: 'fresh',
          execution_mode: 'background',
          isolation: 'shared',
        },
        agentToolContext,
      ),
    ).rejects.toThrow('delegation depth is limited to one');
  });

  it('父运行已中断时，排队中的第二次委派不会创建任务', async () => {
    const registry = await createRegistry();
    const start = vi.fn();
    const controller = new AbortController();
    controller.abort('client interrupt');
    const tools = createSubagentTools({
      request: parentRequest('/workspace'),
      definition: {
        config: {
          cwd: '/workspace',
          subagents: enabledSubagents,
        } as CodingAgentConfig,
        definition: registry.get('build'),
        agentRegistry: registry,
      },
      parentToolNames: [],
      service: { start } as unknown as AgentTaskService,
      approval: () => () => ({ action: 'auto' }),
    });
    const delegate = requireDelegateTool(tools);

    await expect(
      delegate.execute(delegateInput(), {
        ...agentToolContext,
        signal: controller.signal,
      }),
    ).rejects.toBe('client interrupt');
    expect(start).not.toHaveBeenCalled();
  });

  it('allowed_paths 策略允许在父级已授权根内切换到兄弟 package', async () => {
    const root = await temporaryMonorepo();
    const parentCwd = path.join(root, 'packages', 'ello-tui');
    const childCwd = path.join(root, 'packages', 'ello-agent');
    const config = {
      cwd: parentCwd,
      allowed_paths: [root],
      subagents: enabledSubagents,
      agent: {},
    } as CodingAgentConfig;
    const registry = await createAgentRegistry(config);
    const store = await createTaskStore();
    const service = createTaskService(store, new Map());
    const delegate = requireDelegateTool(
      createSubagentTools({
        request: parentRequest(parentCwd),
        definition: {
          config,
          definition: registry.get('build'),
          agentRegistry: registry,
        },
        parentToolNames: [],
        service,
        approval: () => () => ({ action: 'auto' }),
      }),
    );

    await expect(
      delegate.execute(delegateInput({ cwd: childCwd }), agentToolContext),
    ).resolves.toMatchObject({ cwd: childCwd });
    expect(store.list('parent-a')).toEqual([
      expect.objectContaining({
        cwd: childCwd,
        externalPaths: expect.arrayContaining([parentCwd, root]),
      }),
    ]);
  });

  it('workspace 策略严格拒绝兄弟 package，即使它位于 allowed_paths', async () => {
    const root = await temporaryMonorepo();
    const parentCwd = path.join(root, 'packages', 'ello-tui');
    const childCwd = path.join(root, 'packages', 'ello-agent');
    const config = {
      cwd: parentCwd,
      allowed_paths: [root],
      subagents: { enabled: true, cwd_policy: 'workspace' },
      agent: {},
    } as CodingAgentConfig;
    const registry = await createAgentRegistry(config);
    const start = vi.fn();
    const delegate = requireDelegateTool(
      createSubagentTools({
        request: parentRequest(parentCwd),
        definition: {
          config,
          definition: registry.get('build'),
          agentRegistry: registry,
        },
        parentToolNames: [],
        service: { start } as unknown as AgentTaskService,
        approval: () => () => ({ action: 'auto' }),
      }),
    );

    await expect(
      delegate.execute(delegateInput({ cwd: childCwd }), agentToolContext),
    ).rejects.toThrow('outside the parent workspace');
    expect(start).not.toHaveBeenCalled();
  });

  it('allowed_paths 策略拒绝真实越界目录和指向越界目录的符号链接', async () => {
    const root = await temporaryMonorepo();
    const parentCwd = path.join(root, 'packages', 'ello-tui');
    const outside = await mkdtemp(
      path.join(tmpdir(), 'ello-subagent-outside-'),
    );
    temporaryDirectories.push(outside);
    const linkedOutside = path.join(parentCwd, 'linked-outside');
    await symlink(outside, linkedOutside, 'dir');
    const config = {
      cwd: parentCwd,
      allowed_paths: [root],
      subagents: enabledSubagents,
      agent: {},
    } as CodingAgentConfig;
    const registry = await createAgentRegistry(config);
    const start = vi.fn();
    const delegate = requireDelegateTool(
      createSubagentTools({
        request: parentRequest(parentCwd),
        definition: {
          config,
          definition: registry.get('build'),
          agentRegistry: registry,
        },
        parentToolNames: [],
        service: { start } as unknown as AgentTaskService,
        approval: () => () => ({ action: 'auto' }),
      }),
    );

    await expect(
      delegate.execute(delegateInput({ cwd: outside }), agentToolContext),
    ).rejects.toThrow('outside the allowed paths');
    await expect(
      delegate.execute(delegateInput({ cwd: linkedOutside }), agentToolContext),
    ).rejects.toThrow('outside the allowed paths');
    expect(start).not.toHaveBeenCalled();
  });

  it('数据库重开后仍可按 taskId、父线程内名称和 raw agentId 恢复任务', async () => {
    const databasePath = await temporaryDatabasePath();
    const firstHandle = openTestDatabase(databasePath);
    const firstStore = new AgentTaskStore(firstHandle.db);
    const task = firstStore.create(taskInput({ name: 'reader' }));

    expect(task.id).toMatch(/^job_/u);
    expect(task.agentId).toMatch(/^agent_/u);
    expect(task.agentId).not.toBe(task.id);
    firstHandle.close();

    const secondStore = new AgentTaskStore(openTestDatabase(databasePath).db);
    expect(secondStore.get(task.id)).toMatchObject({
      id: task.id,
      agentId: task.agentId,
      status: 'queued',
    });
    expect(secondStore.get('reader', 'parent-a')?.agentId).toBe(task.agentId);
    expect(secondStore.get(task.agentId)?.id).toBe(task.id);
    expect(secondStore.get('reader', 'parent-b')).toBeUndefined();
    expect(secondStore.list('parent-a')).toHaveLength(1);
  });

  it('进程遗留的 running 任务恢复为 recovered 终态', async () => {
    const store = await createTaskStore();
    const task = store.create(taskInput());
    expect(store.markRunning(task.id)?.status).toBe('running');

    expect(store.recoverRunning()).toBe(1);
    expect(store.get(task.id)).toMatchObject({
      status: 'recovered',
      errorMessage: 'Server restarted while the task was running.',
    });
    expect(store.recoverRunning()).toBe(0);
  });

  it('终态与通知原子写入，重复结算不会产生重复通知', async () => {
    const store = await createTaskStore();
    const task = store.create(taskInput());
    store.markRunning(task.id);

    expect(
      store.settle(task.id, { status: 'completed', output: '分析完成' }),
    ).toMatchObject({ status: 'completed', output: '分析完成' });
    expect(
      store.settle(task.id, { status: 'failed', errorMessage: '重复结算' }),
    ).toMatchObject({ status: 'completed', output: '分析完成' });

    const notifications = store.pendingNotifications('parent-a');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      taskId: task.id,
      status: 'completed',
      result: '分析完成',
    });
    store.markNotificationsDelivered([notifications[0]!.id]);
    store.markNotificationsDelivered([notifications[0]!.id]);
    expect(store.pendingNotifications('parent-a')).toEqual([]);
  });

  it('task 与 root 事件序号分别连续，snapshot 与最后提交处于同一屏障', async () => {
    const store = await createTaskStore();
    const first = store.create(taskInput({ name: 'first' }));
    const second = store.create(taskInput({ name: 'second' }));
    store.markRunning(first.id);

    expect(store.events(first.id).map((event) => event.sequence)).toEqual([
      1, 2,
    ]);
    expect(store.events(second.id).map((event) => event.sequence)).toEqual([1]);
    expect(store.snapshot('parent-a')).toMatchObject({
      rootSequence: 3,
      tasks: expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          revision: 2,
          eventSequence: 2,
        }),
        expect.objectContaining({
          id: second.id,
          revision: 1,
          eventSequence: 1,
        }),
      ]),
    });
  });

  it('大工具结果转存 artifact，事件只保留可渲染 preview 和引用', async () => {
    const databasePath = await temporaryDatabasePath();
    const handle = openTestDatabase(databasePath);
    const store = new AgentTaskStore(handle.db);
    const artifacts = new ArtifactStore(
      handle.db,
      path.join(path.dirname(databasePath), 'artifacts'),
    );
    const runs = new Map<string, FakeTaskRun>();
    const service = new AgentTaskService(
      store,
      (task) => {
        const run = new FakeTaskRun();
        runs.set(task.id, run);
        return Promise.resolve(run);
      },
      createAgentTaskEventPreparer(artifacts),
    );
    taskServices.push(service);
    const started = service.start(taskInput());
    const run = await waitForRun(runs, started.task.id);
    const output = '大段工具输出'.repeat(8_000);

    run.emit({
      type: 'toolStarted',
      toolCallId: 'tool_large_output',
      name: 'bash',
      input: { command: 'generate-output' },
      occurredAt: new Date().toISOString(),
    });
    run.emit({
      type: 'toolCompleted',
      toolCallId: 'tool_large_output',
      output,
      occurredAt: new Date().toISOString(),
    });
    run.complete();
    await started.completion;

    const completed = store
      .events(started.task.id)
      .find((event) => event.eventType === 'toolCompleted');
    const artifactId = artifactIdFromEvent(completed?.payload);
    expect(Buffer.byteLength(JSON.stringify(completed?.payload))).toBeLessThan(
      8 * 1024,
    );
    expect((await artifacts.read(artifactId)).toString('utf8')).toBe(output);
  });

  it('同步结果只返回一次，异步结果通过持久通知和名称查询读取', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);

    const sync = service.start(taskInput({ executionMode: 'foreground' }));
    const syncRun = await waitForRun(runs, sync.task.id);
    syncRun.message('同步分析完成');
    syncRun.complete();
    await expect(sync.completion).resolves.toMatchObject({
      status: 'completed',
      output: '同步分析完成',
    });
    service.acknowledge(sync.task.id);
    expect(service.takeNotifications('parent-a')).toBe('');

    const asyncTask = service.start(
      taskInput({ executionMode: 'background', name: 'background-reader' }),
    );
    const asyncRun = await waitForRun(runs, asyncTask.task.id);
    asyncRun.message('异步分析完成');
    asyncRun.complete();
    await asyncTask.completion;
    await expect(
      service.output('background-reader', 'parent-a', 0),
    ).resolves.toMatchObject({
      status: 'completed',
      output: '异步分析完成',
    });
    await expect(
      service.output(asyncTask.task.id, 'parent-b', 0),
    ).rejects.toThrow(`Unknown agent task: ${asyncTask.task.id}`);
    expect(service.takeNotifications('parent-a')).toContain(
      `<task-id>${asyncTask.task.id}</task-id>`,
    );
    expect(service.takeNotifications('parent-a')).toBe('');
  });

  it('后台任务完成会唤醒通知等待者并只消费一次持久通知', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(
      taskInput({ executionMode: 'background', name: 'background-waiter' }),
    );
    const run = await waitForRun(runs, started.task.id);
    const controller = new AbortController();
    const notification = service.waitForNotification(
      'parent-a',
      controller.signal,
    );

    run.message('等待后的分析结果');
    run.complete();

    await expect(notification).resolves.toContain('等待后的分析结果');
    expect(service.takeNotifications('parent-a')).toBe('');
    await started.completion;
  });

  it('运行层误报 completed 但没有最终答复时结算为 failed', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(taskInput({ executionMode: 'foreground' }));
    const run = await waitForRun(runs, started.task.id);

    run.complete();

    await expect(started.completion).resolves.toMatchObject({
      status: 'failed',
      errorMessage: 'Agent task completed without a final answer.',
    });
    expect(store.require(started.task.id).output).toBeUndefined();
  });

  it('停止运行中任务会触发 interrupt，并稳定保留 killed 终态', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(
      taskInput({ executionMode: 'background', name: 'reader' }),
    );
    const run = await waitForRun(runs, started.task.id);

    await expect(service.stop('reader', 'parent-a')).resolves.toMatchObject({
      status: 'killed',
      errorMessage: 'Parent stopped the task.',
    });
    expect(run.interruptions).toEqual([
      `agent task tree ${started.task.id} stopped`,
    ]);
    await expect(started.completion).resolves.toMatchObject({
      status: 'killed',
    });
    await expect(
      service.stop(started.task.id, 'parent-a'),
    ).resolves.toMatchObject({ status: 'killed' });
  });

  it('父任务停止时递归收口后代，不扩大到无关任务', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const parent = service.start(
      taskInput({ executionMode: 'background', name: 'parent' }),
    );
    const child = service.start(
      taskInput({
        executionMode: 'background',
        name: 'child',
        parentTaskId: parent.task.id,
      }),
    );
    const unrelated = service.start(
      taskInput({ executionMode: 'background', name: 'unrelated' }),
    );
    const parentRun = await waitForRun(runs, parent.task.id);
    const childRun = await waitForRun(runs, child.task.id);
    const unrelatedRun = await waitForRun(runs, unrelated.task.id);

    await expect(
      service.stop(parent.task.id, 'parent-a'),
    ).resolves.toMatchObject({
      status: 'killed',
    });
    expect(store.require(child.task.id)).toMatchObject({
      status: 'killed',
      errorMessage: `Ancestor task ${parent.task.id} was stopped.`,
    });
    expect(store.require(unrelated.task.id).status).toBe('running');
    expect(parentRun.interruptions).toEqual([
      `agent task tree ${parent.task.id} stopped`,
    ]);
    expect(childRun.interruptions).toEqual([
      `agent task tree ${parent.task.id} stopped`,
    ]);

    unrelatedRun.complete();
    await unrelated.completion;
  });

  it('foreground 原地转为 background 后只释放交付门，原 run 继续完成', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(
      taskInput({ executionMode: 'foreground', name: 'foreground-reader' }),
    );
    const run = await waitForRun(runs, started.task.id);

    expect(service.background('foreground-reader', 'parent-a')).toMatchObject({
      id: started.task.id,
      status: 'running',
      executionMode: 'background',
    });
    await expect(started.delivery).resolves.toMatchObject({
      id: started.task.id,
      status: 'running',
      executionMode: 'background',
    });
    expect(run.interruptions).toEqual([]);

    run.message('后台完成');
    run.complete();
    await expect(started.completion).resolves.toMatchObject({
      id: started.task.id,
      status: 'completed',
      output: '后台完成',
    });
    expect(service.takeNotifications('parent-a')).toContain(
      `<task-id>${started.task.id}</task-id>`,
    );
  });

  it('重复 steer 只进入一次持久事件和 live run', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(taskInput({ executionMode: 'background' }));
    const run = await waitForRun(runs, started.task.id);

    service.steer(started.task.id, 'parent-a', 'steer-one', '继续检查');
    service.steer(started.task.id, 'parent-a', 'steer-one', '继续检查');

    expect(run.steers).toEqual([{ steerId: 'steer-one', input: '继续检查' }]);
    expect(
      store
        .events(started.task.id)
        .filter((event) => event.eventType === 'steer.queued'),
    ).toHaveLength(1);
    run.complete();
    await started.completion;
  });

  it('resume 单独记录恢复血缘，并复用已持久化 sidechain', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(
      taskInput({
        executionMode: 'background',
        parentTaskId: 'job_parent',
      }),
    );
    const firstRun = await waitForRun(runs, started.task.id);
    firstRun.appendMessage('已确认事实');
    firstRun.complete();
    const completed = await started.completion;

    const resumed = service.resume(
      completed.id,
      'parent-a',
      '继续验证剩余问题',
    );
    expect(resumed.task).toMatchObject({
      resumeFromTaskId: completed.id,
      parentTaskId: 'job_parent',
      prompt: '继续验证剩余问题',
      sidechain: [{ role: 'assistant', content: '已确认事实' }],
    });
    const resumedRun = await waitForRun(runs, resumed.task.id);
    resumedRun.message('恢复分析完成');
    resumedRun.complete();
    await expect(resumed.completion).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('公开 RPC 完整投影任务树，并按连接管理控制操作与通知', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const feature = new AgentTaskRpcFeature(service);
    const notifications: ServerNotification[] = [];
    const peer = createTestPeer({
      connectionId: 'connection-agent-task',
      notify: (notification) => {
        notifications.push(notification);
        return Promise.resolve();
      },
    });

    await expect(
      invokeServiceRoute(feature, peer, 'agent/task/subscribe', {
        threadId: 'parent-a',
      }),
    ).resolves.toEqual({ rootThreadId: 'parent-a', seq: 0, tasks: [] });

    const started = service.start(
      taskInput({ executionMode: 'foreground', name: 'rpc-reader' }),
    );
    const run = await waitForRun(runs, started.task.id);
    await vi.waitFor(() => expect(notifications).toHaveLength(2));
    expect(notifications.map((notification) => notification.method)).toEqual([
      'agent/task/event',
      'agent/task/event',
    ]);
    expect(notifications.map(taskNotificationSequence)).toEqual([1, 2]);
    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            task: expect.objectContaining({ taskId: started.task.id }),
          }),
        }),
      ]),
    );

    await expect(
      invokeServiceRoute(feature, peer, 'agent/task/list', {
        threadId: 'parent-a',
      }),
    ).resolves.toMatchObject({
      rootThreadId: 'parent-a',
      seq: 2,
      tasks: [{ taskId: started.task.id, status: 'running' }],
    });
    await expect(
      invokeServiceRoute(feature, peer, 'agent/task/read', {
        threadId: 'parent-a',
        taskId: started.task.id,
      }),
    ).resolves.toMatchObject({
      task: { taskId: started.task.id, status: 'running' },
      prompt: '分析目标代码',
      events: [
        { sequence: 1, eventType: 'created' },
        { sequence: 2, eventType: 'status' },
      ],
    });

    await expect(
      invokeServiceRoute(feature, peer, 'agent/task/background', {
        threadId: 'parent-a',
        taskId: started.task.id,
      }),
    ).resolves.toMatchObject({
      task: {
        taskId: started.task.id,
        status: 'running',
        executionMode: 'background',
      },
    });
    await expect(
      invokeServiceRoute(feature, peer, 'agent/task/steer', {
        threadId: 'parent-a',
        taskId: started.task.id,
        steerId: 'steer_rpc_1',
        input: '继续检查协议边界',
      }),
    ).resolves.toMatchObject({
      task: { taskId: started.task.id, status: 'running' },
    });
    expect(run.steers).toEqual([
      { steerId: 'steer_rpc_1', input: '继续检查协议边界' },
    ]);

    await expect(
      invokeServiceRoute(feature, peer, 'agent/task/stop', {
        threadId: 'parent-a',
        taskId: started.task.id,
      }),
    ).resolves.toMatchObject({
      task: { taskId: started.task.id, status: 'killed' },
    });
    await expect(started.completion).resolves.toMatchObject({
      status: 'killed',
    });

    const resumed = await invokeServiceRoute(
      feature,
      peer,
      'agent/task/resume',
      {
        threadId: 'parent-a',
        taskId: started.task.id,
        prompt: '从持久上下文继续',
        executionMode: 'background',
      },
    );
    expect(resumed.task).toMatchObject({
      resumeFromTaskId: started.task.id,
      status: 'queued',
      executionMode: 'background',
    });
    const resumedRun = await waitForRun(runs, resumed.task.taskId);

    await invokeServiceRoute(feature, peer, 'agent/task/unsubscribe', {
      threadId: 'parent-a',
    });
    await vi.waitFor(() =>
      expect(
        taskNotificationSequence(notifications.at(-1)),
      ).toBeGreaterThanOrEqual(7),
    );
    const countAfterUnsubscribe = notifications.length;
    await invokeServiceRoute(feature, peer, 'agent/task/steer', {
      threadId: 'parent-a',
      taskId: resumed.task.taskId,
      steerId: 'steer_rpc_2',
      input: '订阅释放后继续',
    });
    await Promise.resolve();
    expect(notifications).toHaveLength(countAfterUnsubscribe);

    resumedRun.complete();
    feature.releaseConnection(peer.connectionId);
    feature.close();
  });
});

function parentRequest(cwd: string): AgentRunRequest {
  return {
    threadId: 'parent-a',
    turnId: 'turn-parent',
    executionLocation: {
      environmentRef: 'test',
      workingDirectory: cwd,
    },
    selection: { mode: 'accept-edits', agent: 'build' },
    history: [],
    input: '委派任务',
    goal: null,
    permission: { rules: () => [], externalPaths: () => [] },
  };
}

function requireDelegateTool(tools: ReturnType<typeof createSubagentTools>) {
  const delegate = tools.find((tool) => tool.name === 'delegate_to_subagent');
  if (delegate === undefined || !('execute' in delegate)) {
    throw new Error('主代理缺少可执行的委派工具。');
  }
  return delegate;
}

function delegateInput(overrides: { readonly cwd?: string } = {}) {
  return {
    subagent_type: 'explore',
    prompt: '检查目标代码',
    description: '检查目标代码',
    context_mode: 'fresh' as const,
    execution_mode: 'background' as const,
    isolation: 'shared' as const,
    ...overrides,
  };
}

async function temporaryMonorepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-subagent-monorepo-'));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(path.join(root, 'packages', 'ello-tui'), { recursive: true }),
    mkdir(path.join(root, 'packages', 'ello-agent'), { recursive: true }),
  ]);
  return root;
}

function taskInput(overrides: Partial<CreateAgentTask> = {}): CreateAgentTask {
  return {
    rootThreadId: 'parent-a',
    description: '分析目标代码',
    definitionName: 'explore',
    contextMode: 'fresh',
    executionMode: 'background',
    prompt: '分析目标代码',
    cwd: '/workspace',
    isolation: 'shared',
    maxTurns: 4,
    depth: 1,
    sidechain: [],
    toolNames: ['read', 'grep'],
    permissionRules: [],
    externalPaths: [],
    ...overrides,
  };
}

function taskNotificationSequence(
  notification: ServerNotification | undefined,
): number | undefined {
  if (
    notification?.method !== 'agent/task/updated' &&
    notification?.method !== 'agent/task/event'
  ) {
    return undefined;
  }
  return notification.params.seq;
}

async function temporaryDatabasePath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-agent-task-store-'));
  temporaryDirectories.push(root);
  return path.join(root, 'state.sqlite');
}

async function createTaskStore(): Promise<AgentTaskStore> {
  return new AgentTaskStore(openTestDatabase(await temporaryDatabasePath()).db);
}

function openTestDatabase(databasePath: string): DatabaseHandle {
  const handle = openDatabase({ databasePath });
  databaseHandles.push(handle);
  return handle;
}

function createTaskService(
  store: AgentTaskStore,
  runs: Map<string, FakeTaskRun>,
): AgentTaskService {
  const service = new AgentTaskService(store, (task) => {
    const run = new FakeTaskRun();
    runs.set(task.id, run);
    return Promise.resolve(run);
  });
  taskServices.push(service);
  return service;
}

async function waitForRun(
  runs: Map<string, FakeTaskRun>,
  taskId: string,
): Promise<FakeTaskRun> {
  await vi.waitFor(() => expect(runs.has(taskId)).toBe(true));
  const run = runs.get(taskId);
  if (run === undefined) throw new Error(`子代理运行尚未创建：${taskId}`);
  return run;
}

const EMPTY_USAGE = {
  requests: 1,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  toolCalls: 0,
} as const;

const agentToolContext = {
  runId: 'run-parent',
  turnIndex: 0,
  toolCallId: 'tool-parent',
  environment: createTestEnvironmentHandle(),
  metadata: {},
  signal: new AbortController().signal,
} as const;

class FakeTaskRun implements AgentRun {
  readonly interruptions: string[] = [];
  readonly steers: Array<{ readonly steerId: string; readonly input: string }> =
    [];
  readonly events: AsyncIterable<AgentRunEvent>;
  readonly result: Promise<AgentRunResult>;
  private readonly queue = new TaskEventQueue();
  private readonly resolveResult: (result: AgentRunResult) => void;
  private settled = false;

  constructor() {
    this.events = this.queue;
    let resolveResult: ((result: AgentRunResult) => void) | undefined;
    this.result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    if (resolveResult === undefined) throw new Error('测试运行初始化失败。');
    this.resolveResult = resolveResult;
  }

  message(text: string): void {
    this.queue.push({
      type: 'messageCompleted',
      messageId: 'message-1',
      text,
    });
  }

  appendMessage(text: string): void {
    this.queue.push({
      type: 'messagesAppended',
      messages: [{ role: 'assistant', content: text }],
    });
  }

  emit(event: AgentRunEvent): void {
    this.queue.push(event);
  }

  complete(): void {
    this.finish({ status: 'completed', usage: EMPTY_USAGE });
  }

  steer(steerId: string, input: string): void {
    this.steers.push({ steerId, input });
  }

  notify(): void {}

  interrupt(reason: string): void {
    this.interruptions.push(reason);
    this.finish({ status: 'interrupted', usage: EMPTY_USAGE, reason });
  }

  resume(): void {}

  private finish(result: AgentRunResult): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.end();
    this.resolveResult(result);
  }
}

function artifactIdFromEvent(payload: unknown): string {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('output' in payload)
  ) {
    throw new Error('工具完成事件缺少 output。');
  }
  const output = (payload as { readonly output?: unknown }).output;
  if (
    typeof output !== 'object' ||
    output === null ||
    !('metadata' in output)
  ) {
    throw new Error('工具完成事件缺少 artifact metadata。');
  }
  const metadata = (output as { readonly metadata?: unknown }).metadata;
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('artifactId' in metadata) ||
    typeof metadata.artifactId !== 'string'
  ) {
    throw new Error('工具完成事件缺少 artifactId。');
  }
  return metadata.artifactId;
}

class TaskEventQueue implements AsyncIterable<AgentRunEvent> {
  private readonly events: AgentRunEvent[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<AgentRunEvent>) => void
  > = [];
  private ended = false;

  [Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
    return { next: () => this.next() };
  }

  push(event: AgentRunEvent): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.events.push(event);
    else waiter({ done: false, value: event });
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  private next(): Promise<IteratorResult<AgentRunEvent>> {
    const event = this.events.shift();
    if (event !== undefined) {
      return Promise.resolve({ done: false, value: event });
    }
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
