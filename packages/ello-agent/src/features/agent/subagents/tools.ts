/**
 * 本文件定义主 Agent 可见的子代理启动与控制工具。
 *
 * 工具只负责参数、权限和上下文派生；任务生命周期与前后台竞态统一交给 AgentTaskService。
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';

import type { CodingAgentConfig } from '../../config/index.js';
import type { ApprovalFor } from '../../tool/index.js';
import type { AgentRunRequest, ResolvedAgentDefinition } from '../contracts.js';
import { defineTool, z, type AnyAgentTool } from '../engine/index.js';

import type { CodingAgentDefinition } from './schema.js';
import { deriveSubagentPermission } from './subagent-permissions.js';
import type { AgentTaskService } from './task-service.js';
import {
  AgentTaskContextModeSchema,
  AgentTaskExecutionModeSchema,
  AgentTaskIsolationSchema,
  type AgentTask,
} from './task-store.js';

/** 创建当前父 run 专属的委派、输出和停止工具。 */
export function createSubagentTools(input: {
  readonly request: AgentRunRequest;
  readonly definition: ResolvedAgentDefinition;
  readonly parentToolNames: readonly string[];
  readonly service: AgentTaskService;
  readonly approval: ApprovalFor;
}): readonly AnyAgentTool[] {
  const controls: AnyAgentTool[] = [
    createTaskOutputTool(input),
    createTaskStopTool(input),
  ];
  const depth = input.request.delegation?.depth ?? 0;
  const explicitlyDelegatable =
    input.definition.definition.tools?.includes('delegate_to_subagent') ===
    true;
  const forkRequiresExactDelegate =
    input.request.delegation?.contextMode === 'fork' &&
    input.request.delegation.exactToolNames?.includes(
      'delegate_to_subagent',
    ) === true;
  if (depth >= 1 && !explicitlyDelegatable && !forkRequiresExactDelegate) {
    return controls;
  }
  const candidates = input.definition.agentRegistry.delegatable();
  return candidates.length === 0
    ? controls
    : [createDelegateTool(input, candidates), ...controls];
}

function createDelegateTool(
  input: {
    readonly request: AgentRunRequest;
    readonly definition: ResolvedAgentDefinition;
    readonly parentToolNames: readonly string[];
    readonly service: AgentTaskService;
    readonly approval: ApprovalFor;
  },
  candidates: readonly CodingAgentDefinition[],
): AnyAgentTool {
  const candidateNames = candidates.map((candidate) => candidate.name);
  return defineTool({
    name: 'delegate_to_subagent',
    description: delegateDescription(
      candidates,
      cwdPolicy(input.definition.config),
      authorizedChildRoots(input),
    ),
    discovery: {
      aliases: ['agent', 'delegate', 'subagent'],
      risk: 'workspace-write',
    },
    input: z
      .object({
        subagent_type: z.enum(candidateNames),
        prompt: z.string().min(1),
        description: z.string().min(1),
        model: z.enum(['primary_model', 'auxiliary_model']).optional(),
        context_mode: AgentTaskContextModeSchema.default('fresh'),
        execution_mode: AgentTaskExecutionModeSchema.default('foreground'),
        cwd: z.string().min(1).optional(),
        isolation: AgentTaskIsolationSchema.default('shared'),
        name: z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u)
          .optional(),
      })
      .strict(),
    approval: (toolInput, context) =>
      input.approval('delegate_to_subagent')(toolInput as never, context),
    capabilities: () => ({
      concurrencySafe: false,
      readOnly: false,
      destructive: false,
      interruptible: true,
      telemetryTag: 'agent.delegate',
    }),
    execute: async (toolInput, context) => {
      const depth = input.request.delegation?.depth ?? 0;
      const explicitlyDelegatable =
        input.definition.definition.tools?.includes('delegate_to_subagent') ===
        true;
      if (depth >= 1 && !explicitlyDelegatable) {
        throw new Error(
          'Subagent delegation depth is limited to one unless its definition explicitly allows delegate_to_subagent.',
        );
      }
      if (toolInput.isolation !== 'shared') {
        throw new Error(
          `${toolInput.isolation} isolation belongs to the P3 workspace coordinator; P2 delegation supports shared isolation only.`,
        );
      }
      context.signal.throwIfAborted();
      const authorizedRoots = authorizedChildRoots(input);
      const cwd = resolveChildCwd(
        input.request.cwd,
        toolInput.cwd,
        cwdPolicy(input.definition.config),
        authorizedRoots,
      );
      const started = startNewTask(input, toolInput, cwd, authorizedRoots);
      if (toolInput.execution_mode === 'background') {
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
    'Run one configured subagent by type.',
    'context_mode controls fresh/fork context; execution_mode controls whether this tool waits or returns a durable task handle.',
    'Use task_output and task_stop for background work.',
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
    readonly parentToolNames: readonly string[];
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
    toolNames: fork ? [...input.parentToolNames] : [],
    permissionRules,
    externalPaths: authorizedRoots,
  });
}

function createTaskOutputTool(input: {
  readonly request: AgentRunRequest;
  readonly service: AgentTaskService;
}): AnyAgentTool {
  return defineTool({
    name: 'task_output',
    description:
      'Read a durable subagent task by task id or root-thread-local name. Set block=true to wait briefly for a live task.',
    discovery: { aliases: ['agent output'], risk: 'readonly' },
    input: z
      .object({
        task_id: z.string().min(1),
        block: z.boolean().default(false),
        timeout_ms: z.number().int().min(100).max(60_000).default(30_000),
      })
      .strict(),
    capabilities: () => ({
      concurrencySafe: true,
      readOnly: true,
      destructive: false,
      interruptible: true,
      telemetryTag: 'agent.task_output',
    }),
    execute: async ({ task_id, block, timeout_ms }) =>
      taskView(
        await input.service.output(
          task_id,
          input.request.delegation?.rootThreadId ?? input.request.threadId,
          block ? timeout_ms : 0,
        ),
      ),
  });
}

function createTaskStopTool(input: {
  readonly request: AgentRunRequest;
  readonly service: AgentTaskService;
  readonly approval: ApprovalFor;
}): AnyAgentTool {
  return defineTool({
    name: 'task_stop',
    description:
      'Stop one queued or running subagent task. Terminal tasks are returned unchanged.',
    discovery: { aliases: ['stop agent'], risk: 'workspace-write' },
    input: z.object({ task_id: z.string().min(1) }).strict(),
    approval: (toolInput, context) =>
      input.approval('task_stop')(toolInput as never, context),
    capabilities: () => ({
      concurrencySafe: false,
      readOnly: false,
      destructive: false,
      interruptible: false,
      telemetryTag: 'agent.task_stop',
    }),
    execute: async ({ task_id }) =>
      taskView(
        await input.service.stop(
          task_id,
          input.request.delegation?.rootThreadId ?? input.request.threadId,
        ),
      ),
  });
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
    throw new Error(`Subagent cwd is outside the ${scope}: ${resolved}`);
  }
  return resolved;
}

function cwdPolicy(config: CodingAgentConfig): 'workspace' | 'allowed_paths' {
  return config.subagents?.cwd_policy ?? 'allowed_paths';
}

function authorizedChildRoots(input: {
  readonly request: AgentRunRequest;
  readonly definition: ResolvedAgentDefinition;
}): readonly string[] {
  const parentCwd = input.request.cwd;
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
