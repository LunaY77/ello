/**
 * 本文件验证 subagent-contract 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createAgentCommands } from '../../src/app.js';
import type {
  AgentRun,
  AgentRunEvent,
  AgentRunResult,
  AgentRunRequest,
} from '../../src/features/agent/index.js';
import {
  AgentTaskService,
  AgentTaskStore,
  AgentTaskRpcFeature,
  createAgentRegistry,
  createAgentTaskEventPreparer,
  createSubagentCommands,
  deriveSubagentPermission,
  parseAgentTaskResult,
  type AgentTaskResult,
  type CreateAgentTask,
  type CodingAgentDefinition,
} from '../../src/features/agent/subagents/index.js';
import { ArtifactStore } from '../../src/features/artifact/index.js';
import {
  AgentConfigSchema,
  CodingAgentConfigSchema,
  SubagentsConfigSchema,
  type CodingAgentConfig,
} from '../../src/features/config/index.js';
import { createTaskBoardStore } from '../../src/features/task/index.js';
import type { PermissionRule } from '../../src/features/tool/permissions/types.js';
import {
  configureCodingDatabase,
  createCodingDatabase,
} from '../../src/infra/database/database.js';
import {
  openDatabase,
  type DatabaseHandle,
} from '../../src/infra/database/index.js';
import type { ServerNotification } from '../../src/protocol/v1/index.js';
import { defineTestCommand } from '../support/command.js';
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
commands:
  - read
  - search
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
      commands: ['read', 'search'],
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
      createSubagentCommands({
        request: parentRequest(cwd),
        definition: {
          config,
          definition: registry.get('build'),
          agentRegistry: registry,
        },
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

  it('始终禁止递归委派与用户提问，任务工具默认关闭', () => {
    const defaults = deriveSubagentPermission([], subagentDefinition);
    expect(defaults).toContainEqual(
      expect.objectContaining({
        pattern: 'spawn_agent',
        action: 'deny',
      }),
    );
    expect(defaults).toContainEqual(
      expect.objectContaining({
        pattern: 'request_user_input',
        action: 'deny',
      }),
    );
    expect(defaults).toContainEqual(
      expect.objectContaining({ pattern: 'task_create', action: 'deny' }),
    );

    const delegated = deriveSubagentPermission([], {
      ...subagentDefinition,
      commands: ['spawn_agent', 'request_user_input'],
    });
    expect(
      delegated.filter((rule) => rule.pattern === 'spawn_agent'),
    ).toHaveLength(1);
    expect(
      delegated.filter((rule) => rule.pattern === 'request_user_input'),
    ).toHaveLength(1);

    const tasked = deriveSubagentPermission([], {
      ...subagentDefinition,
      commands: ['task_list'],
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
    const tools = createSubagentCommands({
      request,
      definition: {
        config: {
          cwd: '/workspace',
          subagents: enabledSubagents,
        } as CodingAgentConfig,
        definition: registry.get('build'),
        agentRegistry: registry,
      },
      service: {} as AgentTaskService,
      approval: () => () => ({ action: 'auto' }),
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      'spawn_agent',
      'list_agents',
      'get_agent',
      'wait_agent',
      'stop_agent',
    ]);
    const spawn = testCommand(tools, 'spawn_agent');

    expect(spawn.description).toContain('Available Subagents:');
    expect(spawn.description).toContain('- explore:');
    expect(spawn.description).toContain('- worker:');
    const wait = testCommand(tools, 'wait_agent');
    expect(
      wait.input.safeParse({ agent_id: 'job_reader', timeout_ms: 999 }).success,
    ).toBe(false);
    expect(
      wait.input.safeParse({ agent_id: 'job_reader', timeout_ms: 180_000 })
        .success,
    ).toBe(true);
    expect(
      spawn.input.safeParse({
        agent: '不存在',
        objective: '检查代码',
        scope: 'src',
        expected_outcome: '返回报告',
        acceptance_evidence: ['结果可验证'],
      }).success,
    ).toBe(false);
    expect(
      spawn.input.safeParse({
        agent: 'explore',
        objective: '检查代码',
        scope: 'src',
        known_facts: ['已有事实'],
        constraints: ['只读'],
        expected_outcome: '返回报告',
        acceptance_evidence: ['结果可验证'],
      }).success,
    ).toBe(true);
  });

  it('Subagent 运行不装配任何 Agent 控制 Command', async () => {
    const registry = await createRegistry();
    const request: AgentRunRequest = {
      ...parentRequest('/workspace'),
      threadId: 'job_child',
      turnId: 'job_child',
      selection: { mode: 'accept-edits', agent: 'explore' },
      delegation: {
        taskId: 'job_child',
        agentId: 'agent_child',
        rootThreadId: 'parent-a',
        maxTurns: 4,
      },
    };

    expect(
      createSubagentCommands({
        request,
        definition: {
          config: {
            cwd: '/workspace',
            subagents: enabledSubagents,
          } as CodingAgentConfig,
          definition: registry.get('explore'),
          agentRegistry: registry,
        },
        service: {} as AgentTaskService,
        approval: () => () => ({ action: 'auto' }),
      }),
    ).toEqual([]);
  });

  it('真实 Command 装配只向 Primary 暴露 Agent 控制与用户提问', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ello-command-assembly-'));
    temporaryDirectories.push(cwd);
    const config = CodingAgentConfigSchema.parse({
      cwd,
      initial_mode: 'accept-edits',
      models: {
        test: {
          protocol: 'openai',
          endpoint: 'responses',
          api_model: 'test-model',
          base_url: 'https://api.example.test/v1',
          api_key_env: 'TEST_API_KEY',
          context_window: 128_000,
          max_output_tokens: 16_000,
        },
      },
      primary_model: 'test',
      auxiliary_model: 'test',
    });
    const registry = await createAgentRegistry(config);
    const databasePath = await temporaryDatabasePath();
    const handle = openTestDatabase(databasePath);
    const store = new AgentTaskStore(handle.db);
    const service = createTaskService(store, new Map());
    const createCommands = createAgentCommands(
      createTaskBoardStore(handle.db),
      service,
    );
    const activationCommand = defineTestCommand({
      name: 'activate_skill',
      summary: 'Activate a test skill.',
      schema: z.object({ name: z.string() }).strict(),
      run: ({ name }) => ({ name }),
    });
    const context = {
      skills: [],
      activationCommand,
      readRoots: () => [cwd],
      createSystemSections: () => [],
    };
    const primaryRequest = parentRequest(cwd);
    const primary = await createCommands({
      request: primaryRequest,
      definition: {
        config,
        definition: registry.get('build'),
        agentRegistry: registry,
      },
      context,
    });
    const subagentRequest: AgentRunRequest = {
      ...parentRequest(cwd),
      threadId: 'job_child',
      turnId: 'job_child',
      selection: { mode: 'accept-edits', agent: 'explore' },
      history: [
        { role: 'user', content: 'Primary history must not grant tools.' },
      ],
      delegation: {
        taskId: 'job_child',
        agentId: 'agent_child',
        rootThreadId: 'parent-a',
        maxTurns: 4,
      },
    };
    const subagent = await createCommands({
      request: subagentRequest,
      definition: {
        config,
        definition: registry.get('explore'),
        agentRegistry: registry,
      },
      context,
    });

    for (const name of [
      'spawn_agent',
      'list_agents',
      'get_agent',
      'wait_agent',
      'stop_agent',
    ]) {
      expect(primary.commandRun.modelTool.description).toContain(`- ${name}:`);
      expect(subagent.commandRun.modelTool.description).not.toContain(
        `- ${name}:`,
      );
    }
    await expect(
      commandIsDiscoverable(primary.commandRun, 'request_user_input'),
    ).resolves.toBe(true);
    await expect(
      commandIsDiscoverable(subagent.commandRun, 'request_user_input'),
    ).resolves.toBe(false);
  });

  it('父运行已中断时，排队中的第二次委派不会创建任务', async () => {
    const registry = await createRegistry();
    const start = vi.fn();
    const controller = new AbortController();
    controller.abort('client interrupt');
    const tools = createSubagentCommands({
      request: parentRequest('/workspace'),
      definition: {
        config: {
          cwd: '/workspace',
          subagents: enabledSubagents,
        } as CodingAgentConfig,
        definition: registry.get('build'),
        agentRegistry: registry,
      },
      service: { start } as unknown as AgentTaskService,
      approval: () => () => ({ action: 'auto' }),
    });
    const delegate = requireDelegateTool(tools);

    let interrupted: unknown;
    try {
      delegate.execute(delegateInput(), {
        ...agentToolContext,
        signal: controller.signal,
      });
    } catch (error) {
      interrupted = error;
    }
    expect(interrupted).toBe('client interrupt');
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
      createSubagentCommands({
        request: parentRequest(parentCwd),
        definition: {
          config,
          definition: registry.get('build'),
          agentRegistry: registry,
        },
        service,
        approval: () => () => ({ action: 'auto' }),
      }),
    );

    expect(
      delegate.execute(delegateInput({ cwd: childCwd }), agentToolContext),
    ).toMatchObject({ cwd: childCwd });
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
      createSubagentCommands({
        request: parentRequest(parentCwd),
        definition: {
          config,
          definition: registry.get('build'),
          agentRegistry: registry,
        },
        service: { start } as unknown as AgentTaskService,
        approval: () => () => ({ action: 'auto' }),
      }),
    );

    expect(() =>
      delegate.execute(delegateInput({ cwd: childCwd }), agentToolContext),
    ).toThrow('outside the parent workspace');
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
      createSubagentCommands({
        request: parentRequest(parentCwd),
        definition: {
          config,
          definition: registry.get('build'),
          agentRegistry: registry,
        },
        service: { start } as unknown as AgentTaskService,
        approval: () => () => ({ action: 'auto' }),
      }),
    );

    expect(() =>
      delegate.execute(delegateInput({ cwd: outside }), agentToolContext),
    ).toThrow(
      `outside the allowed paths: ${outside}. Authorized cwd roots: ${parentCwd}, ${root}`,
    );
    expect(() =>
      delegate.execute(delegateInput({ cwd: linkedOutside }), agentToolContext),
    ).toThrow('outside the allowed paths');
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

  it('0004 legacy task 数据可升级为 Task Packet、结构化 Result 与新通知 payload', async () => {
    const databasePath = await temporaryDatabasePath();
    const client = new BetterSqlite3(databasePath);
    configureCodingDatabase(client);
    for (let index = 0; index <= 4; index += 1) {
      const names = [
        '0000_tiny_swordsman',
        '0001_remove_change_checkpoints',
        '0002_moaning_inertia',
        '0003_brief_titania',
        '0004_agent_task_runtime_projection',
      ];
      const sql = await readFile(
        path.join(
          process.cwd(),
          'src/infra/database/migrations',
          `${names[index]}.sql`,
        ),
        'utf8',
      );
      for (const statement of sql.split('--> statement-breakpoint')) {
        if (statement.trim() !== '') client.exec(statement);
      }
    }
    client
      .prepare(
        'insert into agent_task_roots (root_thread_id, sequence, updated_at) values (?, ?, ?)',
      )
      .run('legacy-root', 0, '2026-08-15T00:00:00.000Z');
    const insertTask = client.prepare(`
      insert into agent_tasks (
        id, agent_id, root_thread_id, name, description, definition_name, model_selector,
        context_mode, execution_mode, status, prompt, cwd, isolation,
        max_turns, depth, revision, event_sequence, current_tool_json, tool_count,
        recent_tools_json, result_preview, error_preview, output, error_message, usage_json, sidechain_json, tools_json,
        permission_rules_json, external_paths_json, created_at, started_at, completed_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const legacyTask = (
      id: string,
      status: string,
      output: string | null,
      error: string | null,
    ) =>
      insertTask.run(
        id,
        `agent-${id}`,
        'legacy-root',
        id,
        'legacy description',
        'explore',
        null,
        'fresh',
        'background',
        status,
        'legacy prompt',
        '/workspace',
        'worktree',
        4,
        1,
        1,
        0,
        null,
        0,
        '[]',
        null,
        null,
        output,
        error,
        null,
        '[]',
        '[]',
        '[]',
        '[]',
        '2026-08-15T00:00:00.000Z',
        status === 'running' ? '2026-08-15T00:00:01.000Z' : null,
        status === 'running' ? null : '2026-08-15T00:00:02.000Z',
        '2026-08-15T00:00:02.000Z',
      );
    legacyTask(
      'job_legacy_completed',
      'completed',
      'legacy completed output',
      null,
    );
    legacyTask('job_legacy_recovered', 'recovered', null, null);
    legacyTask(
      'job_legacy_killed',
      'killed',
      'partial legacy output',
      'user stopped',
    );
    legacyTask('job_legacy_running', 'running', null, null);
    client
      .prepare(
        'insert into agent_task_notifications (id, task_id, root_thread_id, status, payload_json, created_at, delivered_at) values (?, ?, ?, ?, ?, ?, null)',
      )
      .run(
        'legacy-notification',
        'job_legacy_completed',
        'legacy-root',
        'completed',
        JSON.stringify({ summary: 'legacy summary' }),
        '2026-08-15T00:00:03.000Z',
      );
    const migration = await readFile(
      path.join(
        process.cwd(),
        'src/infra/database/migrations/0005_centralized_subagents.sql',
      ),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim() !== '') client.exec(statement);
    }

    const store = new AgentTaskStore(createCodingDatabase(client));
    expect(store.require('job_legacy_completed')).toMatchObject({
      isolation: 'shared',
      status: 'completed',
      taskPacket: { objective: 'legacy prompt' },
      result: { status: 'completed', summary: 'legacy completed output' },
    });
    expect(store.require('job_legacy_recovered')).toMatchObject({
      status: 'failed',
      result: { status: 'failed', retryable: true },
    });
    expect(store.require('job_legacy_killed')).toMatchObject({
      status: 'stopped',
      result: { status: 'stopped', reason: 'user stopped' },
    });
    expect(store.pendingNotifications('legacy-root')).toMatchObject([
      {
        taskId: 'job_legacy_completed',
        result: { status: 'completed', summary: 'legacy completed output' },
      },
    ]);
    expect(store.recoverRunning()).toBe(1);
    expect(store.require('job_legacy_running')).toMatchObject({
      status: 'failed',
      result: { status: 'failed' },
    });
    client.close();
  });

  it('进程遗留的 queued/running 任务恢复为结构化 failed 终态', async () => {
    const store = await createTaskStore();
    const queued = store.create(taskInput({ name: 'queued' }));
    const running = store.create(taskInput({ name: 'running' }));
    expect(store.markRunning(running.id)?.status).toBe('running');

    expect(store.recoverRunning()).toBe(2);
    expect(store.get(queued.id)).toMatchObject({
      status: 'failed',
      result: { status: 'failed', retryable: true },
    });
    expect(store.get(running.id)).toMatchObject({
      status: 'failed',
      errorMessage: 'Server restarted while the task was running.',
      result: { status: 'failed', retryable: true },
    });
    expect(store.recoverRunning()).toBe(0);
  });

  it('终态与通知原子写入，重复结算不会产生重复通知', async () => {
    const store = await createTaskStore();
    const task = store.create(taskInput());
    store.markRunning(task.id);

    const result = completedResult('分析完成');
    expect(
      store.settle(task.id, { result, output: agentResultText(result) }),
    ).toMatchObject({ status: 'completed', result });
    expect(
      store.settle(task.id, {
        result: failedResult('重复结算'),
        errorMessage: '重复结算',
      }),
    ).toMatchObject({ status: 'completed', result });

    const notifications = store.pendingNotifications('parent-a');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      taskId: task.id,
      status: 'completed',
      result,
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
      type: 'commandRunEvent',
      event: {
        type: 'command.started',
        record: commandRecord('running'),
        occurredAt: new Date().toISOString(),
      },
    });
    run.emit({
      type: 'commandRunEvent',
      event: {
        type: 'command.completed',
        record: { ...commandRecord('completed'), output },
        occurredAt: new Date().toISOString(),
      },
    });
    run.complete();
    await started.completion;

    const completed = store
      .events(started.task.id)
      .find(
        (event) =>
          event.eventType === 'command.completed' &&
          JSON.stringify(event.payload).includes('tool_large_output'),
      );
    const artifactId = artifactIdFromEvent(completed?.payload);
    expect(Buffer.byteLength(JSON.stringify(completed?.payload))).toBeLessThan(
      8 * 1024,
    );
    expect((await artifacts.read(artifactId)).toString('utf8')).toBe(output);
  });

  it('委派始终异步，并可通过通知及名称读取结构化结果', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);

    const asyncTask = service.start(taskInput({ name: 'background-reader' }));
    const asyncRun = await waitForRun(runs, asyncTask.task.id);
    asyncRun.message('异步分析完成');
    asyncRun.complete();
    await expect(asyncTask.completion).resolves.toMatchObject({
      status: 'completed',
      result: { status: 'completed', summary: '异步分析完成' },
    });
    expect(service.read('background-reader', 'parent-a').task).toMatchObject({
      id: asyncTask.task.id,
      result: { status: 'completed', summary: '异步分析完成' },
    });
    expect(() => service.read(asyncTask.task.id, 'parent-b')).toThrow(
      `Unknown agent task: ${asyncTask.task.id}`,
    );
    const delivery = service.takeNotifications('parent-a');
    expect(delivery?.text).toContain(`<task-id>${asyncTask.task.id}</task-id>`);
    expect(service.takeNotifications('parent-a')).toBeUndefined();
    service.releaseNotifications(delivery?.notificationIds ?? []);
    expect(service.takeNotifications('parent-a')?.notificationIds).toEqual(
      delivery?.notificationIds,
    );
  });

  it('后台任务完成会唤醒通知等待者并只消费一次持久通知', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(taskInput({ name: 'background-waiter' }));
    const run = await waitForRun(runs, started.task.id);
    const controller = new AbortController();
    const notification = service.waitForNotification(
      'parent-a',
      controller.signal,
    );

    run.message('等待后的分析结果');
    run.complete();

    const delivery = await notification;
    expect(delivery?.text).toContain('等待后的分析结果');
    expect(service.takeNotifications('parent-a')).toBeUndefined();
    service.acknowledgeNotifications(delivery?.notificationIds ?? []);
    expect(store.pendingNotifications('parent-a')).toEqual([]);
    await started.completion;
  });

  it('运行层误报 completed 但没有最终答复时结算为 failed', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(taskInput());
    const run = await waitForRun(runs, started.task.id);

    run.complete();

    await expect(started.completion).resolves.toMatchObject({
      status: 'failed',
      errorMessage: 'Agent task completed without a final answer.',
    });
    expect(store.require(started.task.id).output).toBeUndefined();
  });

  it('缺少用户决策时持久化 blocked 结果并通知 Primary', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(taskInput({ name: 'blocked-reader' }));
    const run = await waitForRun(runs, started.task.id);
    const result: AgentTaskResult = {
      status: 'blocked',
      summary: '已完成可独立验证的分析。',
      blockingReason: '需要用户选择兼容性策略。',
      questionForUser: '是否删除旧协议字段？',
      completedWork: ['已定位所有旧字段引用。'],
      evidence: ['rg 找到 4 个调用点。'],
    };

    run.emit({
      type: 'messageCompleted',
      messageId: 'message-blocked',
      text: agentResultText(result),
    });
    run.complete();

    await expect(started.completion).resolves.toMatchObject({
      status: 'blocked',
      result,
    });
    expect(service.takeNotifications('parent-a')?.text).toContain(
      '是否删除旧协议字段？',
    );
  });

  it('缺少 remainingRisks 的合法结果按空列表通过校验', () => {
    const parsed = parseAgentTaskResult(
      '<agent-result>{"status":"completed","summary":"tsconfig 有 3 个 compilerOptions 条目。","evidence":["tsconfig.json:3-7"]}</agent-result>',
    );

    expect(parsed).toEqual({
      status: 'completed',
      summary: 'tsconfig 有 3 个 compilerOptions 条目。',
      evidence: ['tsconfig.json:3-7'],
      remainingRisks: [],
    });
  });

  it('校验失败时仍保留已经成立的 summary 与 evidence', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(taskInput({ name: 'salvaged-result' }));
    const run = await waitForRun(runs, started.task.id);

    run.emit({
      type: 'messageCompleted',
      messageId: 'message-salvage',
      text: '<agent-result>{"status":"completed","summary":"读到了 name 字段。","evidence":["package.json:2 name 为 @ello/tui"],"unexpectedField":1}</agent-result>',
    });
    run.complete();

    await expect(started.completion).resolves.toMatchObject({
      status: 'failed',
      result: {
        status: 'failed',
        summary: '读到了 name 字段。',
        evidence: ['package.json:2 name 为 @ello/tui'],
        retryable: true,
      },
    });
  });

  it('修复 fenced JSON、字符串控制字符和 trailing comma 后仍按严格 Result schema 校验', () => {
    const parsed = parseAgentTaskResult(`<agent-result>
\`\`\`json
{"status":"completed","summary":"line one
line two","evidence":["package.json:2",],"remainingRisks":[],}
\`\`\`
</agent-result>`);

    expect(parsed).toEqual({
      status: 'completed',
      summary: 'line one\nline two',
      evidence: ['package.json:2'],
      remainingRisks: [],
    });
  });

  it('非法结构化结果保留有界原始输出供 Primary 诊断', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(taskInput({ name: 'invalid-result' }));
    const run = await waitForRun(runs, started.task.id);
    const raw =
      '<agent-result>{"status":"completed","summary":"unterminated}</agent-result>';

    run.emit({
      type: 'messageCompleted',
      messageId: 'message-invalid',
      text: raw,
    });
    run.complete();

    await expect(started.completion).resolves.toMatchObject({
      status: 'failed',
      output: raw,
      result: {
        status: 'failed',
        retryable: true,
        error: expect.stringContaining(`Raw Subagent output:\n${raw}`),
      },
    });
  });

  it('取消 wait_agent 只释放依赖屏障，不停止仍在运行的 Agent', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(taskInput({ name: 'waited-reader' }));
    const run = await waitForRun(runs, started.task.id);
    const controller = new AbortController();
    const waiting = service.wait(
      'waited-reader',
      'parent-a',
      controller.signal,
      10_000,
    );

    controller.abort(new Error('dependency no longer needed'));

    await expect(waiting).rejects.toThrow('dependency no longer needed');
    expect(store.require(started.task.id).status).toBe('running');
    run.message('继续独立完成');
    run.complete();
    await expect(started.completion).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('wait_agent 超时返回 timed_out 且不停止仍在运行的 Agent', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(taskInput({ name: 'slow-reader' }));
    const run = await waitForRun(runs, started.task.id);

    await expect(
      service.wait('slow-reader', 'parent-a', new AbortController().signal, 5),
    ).resolves.toMatchObject({
      waitStatus: 'timed_out',
      task: { id: started.task.id, status: 'running' },
    });
    expect(store.require(started.task.id).status).toBe('running');

    run.message('稍后完成');
    run.complete();
    await expect(started.completion).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('停止运行中任务会触发 interrupt，并稳定保留 stopped 终态', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(taskInput({ name: 'reader' }));
    const run = await waitForRun(runs, started.task.id);

    await expect(service.stop('reader', 'parent-a')).resolves.toMatchObject({
      status: 'stopped',
      result: { status: 'stopped' },
    });
    expect(run.interruptions).toEqual([
      `agent task ${started.task.id} stopped`,
    ]);
    await expect(started.completion).resolves.toMatchObject({
      status: 'stopped',
    });
    await expect(
      service.stop(started.task.id, 'parent-a'),
    ).resolves.toMatchObject({ status: 'stopped' });
  });

  it('终态后的晚到运行事件不会改写 transcript 或结果', async () => {
    const store = await createTaskStore();
    const run = new FakeTaskRun(false);
    const service = new AgentTaskService(store, () => Promise.resolve(run));
    taskServices.push(service);
    const started = service.start(taskInput({ name: 'late-event-reader' }));
    await vi.waitFor(() =>
      expect(store.require(started.task.id).status).toBe('running'),
    );

    await service.stop(started.task.id, 'parent-a');
    const terminal = store.require(started.task.id);
    const eventCount = store.events(started.task.id).length;
    run.emit({
      type: 'messageCompleted',
      messageId: 'message-late',
      text: agentResultText(completedResult('不应覆盖终态')),
    });
    run.complete();

    await started.completion;
    expect(store.require(started.task.id)).toMatchObject({
      status: 'stopped',
      revision: terminal.revision,
      result: terminal.result,
    });
    expect(store.events(started.task.id)).toHaveLength(eventCount);
  });

  it('launcher 卡住时 close 有界返回且不留下 running 任务', async () => {
    const store = await createTaskStore();
    const service = new AgentTaskService(
      store,
      () => new Promise<AgentRun>(() => undefined),
      undefined,
      20,
    );
    taskServices.push(service);
    const started = service.start(taskInput({ name: 'stuck-launcher' }));
    await vi.waitFor(() =>
      expect(store.require(started.task.id).status).toBe('running'),
    );

    const before = Date.now();
    await service.close();

    expect(Date.now() - before).toBeLessThan(250);
    expect(store.require(started.task.id)).toMatchObject({
      status: 'stopped',
      result: { status: 'stopped' },
    });
  });

  it('重复 steer 只进入一次持久事件和 live run', async () => {
    const store = await createTaskStore();
    const runs = new Map<string, FakeTaskRun>();
    const service = createTaskService(store, runs);
    const started = service.start(taskInput());
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

    const started = service.start(taskInput({ name: 'rpc-reader' }));
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
      taskPacket: { objective: '分析目标代码' },
      events: [
        { sequence: 1, eventType: 'created' },
        { sequence: 2, eventType: 'status' },
      ],
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
      task: { taskId: started.task.id, status: 'stopped' },
    });
    await expect(started.completion).resolves.toMatchObject({
      status: 'stopped',
    });

    await invokeServiceRoute(feature, peer, 'agent/task/unsubscribe', {
      threadId: 'parent-a',
    });
    const countAfterUnsubscribe = notifications.length;
    const afterUnsubscribe = service.start(
      taskInput({ name: 'after-unsubscribe' }),
    );
    const afterUnsubscribeRun = await waitForRun(
      runs,
      afterUnsubscribe.task.id,
    );
    await Promise.resolve();
    expect(notifications).toHaveLength(countAfterUnsubscribe);

    afterUnsubscribeRun.message('订阅释放后完成');
    afterUnsubscribeRun.complete();
    await afterUnsubscribe.completion;
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

function requireDelegateTool(tools: ReturnType<typeof createSubagentCommands>) {
  return testCommand(tools, 'spawn_agent');
}

function testCommand(
  commands: ReturnType<typeof createSubagentCommands>,
  name: string,
) {
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined || command.execution.kind !== 'immediate') {
    throw new Error(`缺少可执行的 Command: ${name}`);
  }
  return {
    description: [command.summary, command.details]
      .filter((value): value is string => value !== undefined)
      .join(' '),
    input: command.invocation.input.schema,
    execute: (input: unknown, context: typeof agentToolContext) =>
      command.execution.kind === 'immediate'
        ? command.execution.run(
            command.invocation.input.schema.parse(input),
            context,
          )
        : undefined,
  };
}

function delegateInput(overrides: { readonly cwd?: string } = {}) {
  return {
    agent: 'explore',
    objective: '检查目标代码',
    scope: '目标 package',
    known_facts: [],
    constraints: ['不要修改范围外文件'],
    expected_outcome: '返回结构化分析报告',
    acceptance_evidence: ['列出检查过的文件'],
    ...overrides,
  };
}

function completedResult(summary: string) {
  return {
    status: 'completed' as const,
    summary,
    evidence: [],
    remainingRisks: [],
  };
}

function failedResult(error: string) {
  return {
    status: 'failed' as const,
    summary: 'Subagent execution failed.',
    error,
    evidence: [],
    retryable: false,
  };
}

function agentResultText(result: AgentTaskResult): string {
  return `<agent-result>${JSON.stringify(result)}</agent-result>`;
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
    taskPacket: {
      objective: '分析目标代码',
      scope: '/workspace',
      knownFacts: [],
      constraints: [],
      expectedOutcome: '返回结构化分析结果',
      acceptanceEvidence: ['报告包含证据'],
    },
    cwd: '/workspace',
    isolation: 'shared',
    maxTurns: 4,
    sidechain: [],
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

async function commandIsDiscoverable(
  runtime: import('../../src/features/command/index.js').CommandRunRuntime,
  name: string,
): Promise<boolean> {
  const execution = runtime.start({
    providerToolCallId: `search-${name}`,
    input: {
      commands: [
        {
          step: 1,
          command: 'command_search',
          args: ['--query', name],
        },
      ],
    },
    context: {
      runId: 'run-command-assembly',
      turnIndex: 0,
      environment: createTestEnvironmentHandle(),
      metadata: {},
      signal: new AbortController().signal,
    },
  });
  for await (const _event of execution) {
    // Drain the execution before reading its terminal transition.
  }
  return JSON.stringify(await execution.result).includes(`"name":"${name}"`);
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
  commandId: 'tool-parent',
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

  constructor(private readonly finishOnInterrupt = true) {
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
      text: agentResultText(completedResult(text)),
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

  acknowledgeCompaction(): void {}

  complete(): void {
    this.finish({ status: 'completed', usage: EMPTY_USAGE });
  }

  steer(steerId: string, input: string): void {
    this.steers.push({ steerId, input });
  }

  notify(): void {}

  interrupt(reason: string): void {
    this.interruptions.push(reason);
    if (this.finishOnInterrupt) {
      this.finish({ status: 'interrupted', usage: EMPTY_USAGE, reason });
    }
  }

  resume(): void {}

  private finish(result: AgentRunResult): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.end();
    this.resolveResult(result);
  }
}

function commandRecord(status: 'running' | 'completed') {
  const occurredAt = new Date().toISOString();
  return {
    commandRunId: 'command-run:large-output',
    commandId: 'tool_large_output',
    index: 0,
    step: 1,
    name: 'bash',
    input: { command: 'generate-output' },
    inputDigest: 'a'.repeat(64),
    status,
    startedAt: occurredAt,
    ...(status === 'completed' ? { completedAt: occurredAt } : {}),
  } as const;
}

function artifactIdFromEvent(payload: unknown): string {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('event' in payload)
  ) {
    throw new Error('Command 完成事件缺少 event。');
  }
  const event = (payload as { readonly event?: unknown }).event;
  if (typeof event !== 'object' || event === null || !('record' in event)) {
    throw new Error('Command 完成事件缺少 record。');
  }
  const record = (event as { readonly record?: unknown }).record;
  if (typeof record !== 'object' || record === null || !('output' in record)) {
    throw new Error('Command record 缺少 output。');
  }
  const output = (record as { readonly output?: unknown }).output;
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
