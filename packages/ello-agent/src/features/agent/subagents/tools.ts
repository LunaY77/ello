/**
 * 本文件定义主 Agent 可见的子代理启动与控制工具。
 *
 * 工具只负责参数、权限和上下文派生；任务生命周期与前后台竞态统一交给 AgentTaskService。
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import {
  cliInput,
  commandInput,
  defineCommand,
  type CommandDefinition,
} from '../../command/index.js';
import type { CodingAgentConfig } from '../../config/index.js';
import type { ApprovalFor } from '../../tool/index.js';
import type { AgentRunRequest, ResolvedAgentDefinition } from '../contracts.js';

import type { CodingAgentDefinition } from './schema.js';
import { deriveSubagentPermission } from './subagent-permissions.js';
import type { AgentTaskService } from './task-service.js';
import {
  AgentTaskContextModeSchema,
  AgentTaskExecutionModeSchema,
  type AgentTask,
} from './task-store.js';

/** 创建当前父 run 专属的委派、输出和停止工具。 */
export function createSubagentCommands(input: {
  readonly request: AgentRunRequest;
  readonly definition: ResolvedAgentDefinition;
  readonly parentCommandNames: readonly string[];
  readonly service: AgentTaskService;
  readonly approval: ApprovalFor;
}): readonly CommandDefinition[] {
  if (!input.definition.config.subagents.enabled) return [];
  const controls: CommandDefinition[] = [
    createTaskOutputCommand(input),
    createTaskStopCommand(input),
  ];
  const depth = input.request.delegation?.depth ?? 0;
  const explicitlyDelegatable =
    input.definition.definition.commands?.includes('delegate_to_subagent') ===
    true;
  const forkRequiresExactDelegate =
    input.request.delegation?.contextMode === 'fork' &&
    input.request.delegation.exactCommandNames?.includes(
      'delegate_to_subagent',
    ) === true;
  if (depth >= 1 && !explicitlyDelegatable && !forkRequiresExactDelegate) {
    return controls;
  }
  const candidates = input.definition.agentRegistry.delegatable();
  return candidates.length === 0
    ? controls
    : [createDelegateCommand(input, candidates), ...controls];
}

function createDelegateCommand(
  input: {
    readonly request: AgentRunRequest;
    readonly definition: ResolvedAgentDefinition;
    readonly parentCommandNames: readonly string[];
    readonly service: AgentTaskService;
    readonly approval: ApprovalFor;
  },
  candidates: readonly CodingAgentDefinition[],
): CommandDefinition {
  const candidateNames = candidates.map((candidate) => candidate.name);
  const commandInputSchema = z
    .object({
      subagent_type: z
        .enum(candidateNames)
        .describe('Configured subagent type to run'),
      prompt: z
        .string()
        .min(1)
        .describe('Complete task prompt for the subagent'),
      description: z
        .string()
        .min(1)
        .describe('Short task description shown in task status'),
      model: z
        .enum(['primary_model', 'auxiliary_model'])
        .optional()
        .describe('Optional model selector override'),
      context_mode: AgentTaskContextModeSchema.default('fresh').describe(
        'Use fresh context or fork the parent context',
      ),
      execution_mode: AgentTaskExecutionModeSchema.default(
        'foreground',
      ).describe('Wait for completion or return a background task handle'),
      cwd: z.string().min(1).optional().describe('Child working directory'),
      isolation: z
        .enum(['shared'])
        .default('shared')
        .describe('Workspace isolation mode'),
      name: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u)
        .optional()
        .describe('Optional root-thread-local task name'),
    })
    .strict();
  return defineCommand({
    name: 'delegate_to_subagent',
    summary: 'Run one configured subagent by type.',
    details: delegateDescription(
      candidates,
      cwdPolicy(input.definition.config),
      authorizedChildRoots(input),
    ),
    aliases: ['agent', 'delegate', 'subagent'],
    risk: 'workspace-write',
    invocation: cliInput(commandInput(commandInputSchema), {
      positionals: [{ field: 'subagent_type', metavar: 'type' }],
      options: [
        'description',
        'model',
        'context_mode',
        'execution_mode',
        'cwd',
        'isolation',
        'name',
      ],
      body: 'prompt',
    }),
    approval: input.approval('delegate_to_subagent'),
    effects: () => ({
      concurrencySafe: false,
      readOnly: false,
      destructive: false,
      interruptible: true,
      telemetryTag: 'agent.delegate',
    }),
    execution: {
      kind: 'immediate',
      run: async (commandInput, context) => {
        const depth = input.request.delegation?.depth ?? 0;
        const explicitlyDelegatable =
          input.definition.definition.commands?.includes(
            'delegate_to_subagent',
          ) === true;
        if (depth >= 1 && !explicitlyDelegatable) {
          throw new Error(
            'Subagent delegation depth is limited to one unless its definition explicitly allows delegate_to_subagent.',
          );
        }
        if (commandInput.isolation !== 'shared') {
          throw new Error(
            `${commandInput.isolation} isolation belongs to the P3 workspace coordinator; P2 delegation supports shared isolation only.`,
          );
        }
        context.signal.throwIfAborted();
        const authorizedRoots = authorizedChildRoots(input);
        const cwd = resolveChildCwd(
          input.request.executionLocation.workingDirectory,
          commandInput.cwd,
          cwdPolicy(input.definition.config),
          authorizedRoots,
        );
        const started = startNewTask(input, commandInput, cwd, authorizedRoots);
        if (commandInput.execution_mode === 'background') {
          return taskView(started.task);
        }
        const stopOnParentAbort = () => {
          void input.service.stop(started.task.id, input.request.threadId);
        };
        if (context.signal.aborted) stopOnParentAbort();
        else {
          context.signal.addEventListener('abort', stopOnParentAbort, {
            once: true,
          });
        }
        try {
          const delivered = await started.delivery;
          if (delivered.executionMode === 'foreground') {
            input.service.acknowledge(delivered.id);
          }
          return taskView(delivered);
        } finally {
          context.signal.removeEventListener('abort', stopOnParentAbort);
        }
      },
    },
  });
}

function delegateDescription(
  candidates: readonly CodingAgentDefinition[],
  policy: 'workspace' | 'allowed_paths',
  authorizedRoots: readonly string[],
): string {
  const catalog = candidates
    .map((candidate) => `- ${candidate.name}: ${candidate.description}`)
    .join('\n');
  return [
    'context_mode selects a fresh context or a fork of the parent context. execution_mode selects whether this Command waits for the result or returns a durable task handle that task_output and task_stop then address.',
    `cwd policy: ${policy}. Omit cwd to inherit the current working directory.`,
    `Authorized cwd roots: ${authorizedRoots.join(', ')}`,
    'Available subagents:',
    catalog,
  ].join('\n');
}

function startNewTask(
  input: {
    readonly request: AgentRunRequest;
    readonly definition: ResolvedAgentDefinition;
    readonly parentCommandNames: readonly string[];
    readonly service: AgentTaskService;
  },
  toolInput: {
    readonly subagent_type: string;
    readonly prompt: string;
    readonly description: string;
    readonly model?: 'primary_model' | 'auxiliary_model' | undefined;
    readonly context_mode: 'fresh' | 'fork';
    readonly execution_mode: 'foreground' | 'background';
    readonly isolation: 'shared' | 'worktree' | 'container';
    readonly name?: string | undefined;
  },
  cwd: string,
  authorizedRoots: readonly string[],
) {
  const childDefinition = input.definition.agentRegistry.get(
    toolInput.subagent_type,
  );
  if (
    !input.definition.agentRegistry
      .delegatable()
      .some((candidate) => candidate.name === childDefinition.name)
  ) {
    throw new Error(`Agent is not delegatable: ${childDefinition.name}`);
  }
  const parentDepth = input.request.delegation?.depth ?? 0;
  const fork = toolInput.context_mode === 'fork';
  const permissionRules = fork
    ? input.request.permission.rules()
    : deriveSubagentPermission(
        input.request.permission.rules(),
        childDefinition,
      );
  return input.service.start({
    rootThreadId:
      input.request.delegation?.rootThreadId ?? input.request.threadId,
    ...(input.request.delegation === undefined
      ? {}
      : { parentTaskId: input.request.delegation.taskId }),
    ...(toolInput.name === undefined ? {} : { name: toolInput.name }),
    description: toolInput.description,
    definitionName: childDefinition.name,
    ...(toolInput.model === undefined
      ? {}
      : { modelSelector: toolInput.model }),
    contextMode: toolInput.context_mode,
    executionMode: toolInput.execution_mode,
    prompt: toolInput.prompt,
    cwd,
    isolation: toolInput.isolation,
    maxTurns: childDefinition.maxTurns ?? 20,
    depth: parentDepth + 1,
    sidechain: fork ? [...input.request.history] : [],
    commandNames: fork ? [...input.parentCommandNames] : [],
    permissionRules,
    externalPaths: authorizedRoots,
  });
}

function createTaskOutputCommand(input: {
  readonly request: AgentRunRequest;
  readonly service: AgentTaskService;
}): CommandDefinition {
  const commandInputSchema = z
    .object({
      task_id: z
        .string()
        .min(1)
        .describe('Subagent task job_ id or root-thread-local name'),
      block: z
        .boolean()
        .default(false)
        .describe('Whether to wait briefly for a live task'),
      timeout_ms: z
        .number()
        .int()
        .min(100)
        .max(180_000)
        .default(30_000)
        .describe('Maximum wait time in milliseconds'),
    })
    .strict();
  return defineCommand({
    name: 'task_output',
    summary:
      'Read one durable subagent task. Persisted task-board ids belong to task_get.',
    aliases: ['agent output'],
    risk: 'readonly',
    invocation: cliInput(commandInput(commandInputSchema), {
      positionals: [{ field: 'task_id', metavar: 'task' }],
      options: ['block', 'timeout_ms'],
    }),
    effects: () => ({
      concurrencySafe: true,
      readOnly: true,
      destructive: false,
      interruptible: true,
      telemetryTag: 'agent.task_output',
    }),
    execution: {
      kind: 'immediate',
      run: async ({ task_id, block, timeout_ms }) => {
        assertSubagentTaskSelector(task_id);
        return taskView(
          await input.service.output(
            task_id,
            input.request.delegation?.rootThreadId ?? input.request.threadId,
            block ? timeout_ms : 0,
          ),
        );
      },
    },
  });
}

function createTaskStopCommand(input: {
  readonly request: AgentRunRequest;
  readonly service: AgentTaskService;
  readonly approval: ApprovalFor;
}): CommandDefinition {
  const commandInputSchema = z
    .object({
      task_id: z
        .string()
        .min(1)
        .describe('Subagent task job_ id or root-thread-local name'),
    })
    .strict();
  return defineCommand({
    name: 'task_stop',
    summary:
      'Stop one queued or running subagent task; a task already in a terminal state is returned unchanged.',
    aliases: ['stop agent'],
    risk: 'workspace-write',
    invocation: cliInput(commandInput(commandInputSchema), {
      positionals: [{ field: 'task_id', metavar: 'task' }],
    }),
    approval: input.approval('task_stop'),
    effects: () => ({
      concurrencySafe: false,
      readOnly: false,
      destructive: false,
      interruptible: false,
      telemetryTag: 'agent.task_stop',
    }),
    execution: {
      kind: 'immediate',
      run: async ({ task_id }) => {
        assertSubagentTaskSelector(task_id);
        return taskView(
          await input.service.stop(
            task_id,
            input.request.delegation?.rootThreadId ?? input.request.threadId,
          ),
        );
      },
    },
  });
}

function assertSubagentTaskSelector(selector: string): void {
  if (
    !/^\d+$/u.test(selector) &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      selector,
    )
  ) {
    return;
  }
  throw new Error(
    `Task '${selector}' is a persisted task-board ID; use task_get to read it, task_update to change it, or task_delete to remove it. task_output and task_stop only accept subagent job_ IDs or local names.`,
  );
}

function resolveChildCwd(
  parentCwd: string,
  requested: string | undefined,
  policy: 'workspace' | 'allowed_paths',
  authorizedRoots: readonly string[],
): string {
  const resolved = realpathSync(path.resolve(parentCwd, requested ?? '.'));
  const roots =
    policy === 'workspace'
      ? [realpathSync(parentCwd)]
      : authorizedRoots.map((root) => realpathSync(root));
  if (!roots.some((root) => pathInside(root, resolved))) {
    const scope = policy === 'workspace' ? 'parent workspace' : 'allowed paths';
    throw new Error(
      `Subagent cwd is outside the ${scope}: ${resolved}. Authorized cwd roots: ${roots.join(', ')}`,
    );
  }
  return resolved;
}

function cwdPolicy(config: CodingAgentConfig): 'workspace' | 'allowed_paths' {
  return config.subagents.cwd_policy;
}

function authorizedChildRoots(input: {
  readonly request: AgentRunRequest;
  readonly definition: ResolvedAgentDefinition;
}): readonly string[] {
  const parentCwd = input.request.executionLocation.workingDirectory;
  const permissionRoots = input.request.permission
    .rules()
    .filter(
      (rule) =>
        rule.permission === 'external_directory' && rule.action === 'allow',
    )
    .map((rule) => path.resolve(parentCwd, rule.pattern));
  return [
    ...new Set([
      parentCwd,
      ...(input.definition.config.allowed_paths ?? []),
      ...input.request.permission.externalPaths(),
      ...permissionRoots,
    ]),
  ];
}

function pathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function taskView(task: AgentTask) {
  return {
    taskId: task.id,
    agentId: task.agentId,
    ...(task.name === undefined ? {} : { name: task.name }),
    agent: task.definitionName,
    description: task.description,
    contextMode: task.contextMode,
    executionMode: task.executionMode,
    status: task.status,
    cwd: task.cwd,
    depth: task.depth,
    revision: task.revision,
    ...(task.output === undefined ? {} : { output: task.output }),
    ...(task.errorMessage === undefined ? {} : { error: task.errorMessage }),
    ...(task.usage === undefined ? {} : { usage: task.usage }),
  };
}
