/**
 * Primary-only Agent Commands.
 *
 * `spawn_agent` is always asynchronous. Subagent runs receive none of these Commands, so recursive
 * delegation is impossible even when a Subagent definition names one explicitly.
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
import type { AgentTask, AgentTaskPacket } from './task-types.js';

const DEFAULT_AGENT_WAIT_TIMEOUT_MS = 120_000;
const MAX_AGENT_WAIT_TIMEOUT_MS = 180_000;

/**
 * Agent 控制 Commands 只读写 Ello 自身的任务存储，从不触碰 Environment。
 *
 * 声明 `usesEnvironment: false` 让它们绕过 Environment 执行 gate：`wait_agent` 会在屏障上
 * 阻塞到分钟级，若占用 gate 就会阻塞同一 Environment 内所有 Subagent 的工具执行。
 */
const AGENT_CONTROL_EFFECTS = { usesEnvironment: false } as const;

export { AGENT_CONTROL_COMMAND_NAMES } from './agent-controls.js';

interface SubagentCommandInput {
  readonly request: AgentRunRequest;
  readonly definition: ResolvedAgentDefinition;
  readonly service: AgentTaskService;
  readonly approval: ApprovalFor;
}

/** 创建当前 Primary run 专属的异步 Agent 控制 Commands。 */
export function createSubagentCommands(
  input: SubagentCommandInput,
): readonly CommandDefinition[] {
  if (!input.definition.config.subagents.enabled) return [];
  if (input.request.delegation !== undefined) return [];
  const controls = [
    createListAgentsCommand(input),
    createGetAgentCommand(input),
    createWaitAgentCommand(input),
    createStopAgentCommand(input),
  ];
  const candidates = input.definition.agentRegistry.delegatable();
  return candidates.length === 0
    ? controls
    : [createSpawnAgentCommand(input, candidates), ...controls];
}

function createSpawnAgentCommand(
  input: SubagentCommandInput,
  candidates: readonly CodingAgentDefinition[],
): CommandDefinition {
  const candidateNames = candidates.map((candidate) => candidate.name);
  const schema = z
    .object({
      agent: z
        .enum(candidateNames)
        .describe('Configured Subagent type to run.'),
      scope: z
        .string()
        .trim()
        .min(1)
        .describe('Owned files, modules, or responsibility boundary.'),
      known_facts: z
        .array(z.string().trim().min(1))
        .max(64)
        .default([])
        .describe('Established facts; repeat this option for multiple facts.'),
      constraints: z
        .array(z.string().trim().min(1))
        .max(64)
        .default([])
        .describe('Constraints to preserve; repeat for multiple constraints.'),
      expected_outcome: z
        .string()
        .trim()
        .min(1)
        .describe('Concrete deliverable expected from the Subagent.'),
      acceptance_evidence: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(64)
        .describe('Required evidence; repeat for multiple acceptance checks.'),
      model: z
        .enum(['primary_model', 'auxiliary_model'])
        .optional()
        .describe('Optional model selector override.'),
      cwd: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('Subagent working directory.'),
      name: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u)
        .optional()
        .describe('Optional root-thread-local Agent name.'),
      objective: z
        .string()
        .trim()
        .min(1)
        .describe('Complete, self-contained objective for the Subagent.'),
    })
    .strict();
  return defineCommand({
    name: 'spawn_agent',
    summary:
      'Start one independent Subagent and immediately return its durable handle.',
    details: spawnDescription(
      candidates,
      cwdPolicy(input.definition.config),
      authorizedChildRoots(input),
    ),
    aliases: [],
    risk: 'workspace-write',
    invocation: cliInput(commandInput(schema), {
      positionals: [{ field: 'agent', metavar: 'agent' }],
      options: [
        'scope',
        'known_facts',
        'constraints',
        'expected_outcome',
        'acceptance_evidence',
        'model',
        'cwd',
        'name',
      ],
      body: 'objective',
    }),
    approval: input.approval('spawn_agent'),
    effects: () => ({
      ...AGENT_CONTROL_EFFECTS,
      concurrencySafe: true,
      readOnly: false,
      destructive: false,
      interruptible: true,
      telemetryTag: 'agent.spawn',
    }),
    execution: {
      kind: 'immediate',
      run: (commandInput, context) => {
        context.signal.throwIfAborted();
        const authorizedRoots = authorizedChildRoots(input);
        const cwd = resolveChildCwd(
          input.request.executionLocation.workingDirectory,
          commandInput.cwd,
          cwdPolicy(input.definition.config),
          authorizedRoots,
        );
        const definition = input.definition.agentRegistry.get(
          commandInput.agent,
        );
        if (
          !candidates.some((candidate) => candidate.name === definition.name)
        ) {
          throw new Error(`Agent is not delegatable: ${definition.name}`);
        }
        const taskPacket: AgentTaskPacket = {
          objective: commandInput.objective,
          scope: commandInput.scope,
          knownFacts: commandInput.known_facts,
          constraints: commandInput.constraints,
          expectedOutcome: commandInput.expected_outcome,
          acceptanceEvidence: commandInput.acceptance_evidence,
        };
        const started = input.service.start({
          rootThreadId: input.request.threadId,
          ...(commandInput.name === undefined
            ? {}
            : { name: commandInput.name }),
          description: oneLine(commandInput.objective),
          definitionName: definition.name,
          ...(commandInput.model === undefined
            ? {}
            : { modelSelector: commandInput.model }),
          taskPacket,
          cwd,
          isolation: 'shared',
          maxTurns: definition.maxTurns ?? 20,
          sidechain: [],
          permissionRules: deriveSubagentPermission(
            input.request.permission.rules(),
            definition,
          ),
          externalPaths: authorizedRoots,
        });
        return agentView(started.task);
      },
    },
  });
}

function createListAgentsCommand(
  input: SubagentCommandInput,
): CommandDefinition {
  const schema = z.object({}).strict();
  return defineCommand({
    name: 'list_agents',
    summary: 'List Subagent instances spawned by this Primary session.',
    aliases: [],
    risk: 'readonly',
    invocation: cliInput(commandInput(schema)),
    effects: readonlyEffects('agent.list'),
    execution: {
      kind: 'immediate',
      run: () => input.service.list(input.request.threadId).map(agentView),
    },
  });
}

function createGetAgentCommand(input: SubagentCommandInput): CommandDefinition {
  const schema = agentSelectorSchema();
  return defineCommand({
    name: 'get_agent',
    summary:
      'Read the current state and structured result of one Subagent instance.',
    aliases: [],
    risk: 'readonly',
    invocation: cliInput(commandInput(schema), {
      positionals: [{ field: 'agent_id', metavar: 'agent' }],
    }),
    effects: readonlyEffects('agent.get'),
    execution: {
      kind: 'immediate',
      run: ({ agent_id }) => {
        assertAgentSelector(agent_id);
        return agentView(
          input.service.read(agent_id, input.request.threadId).task,
        );
      },
    },
  });
}

function createWaitAgentCommand(
  input: SubagentCommandInput,
): CommandDefinition {
  const schema = z
    .object({
      agent_id: agentSelectorField(),
      timeout_ms: z
        .number()
        .int()
        .min(1_000)
        .max(MAX_AGENT_WAIT_TIMEOUT_MS)
        .optional()
        .describe(
          'Maximum barrier wait in milliseconds; timeout does not stop the Agent.',
        ),
    })
    .strict();
  return defineCommand({
    name: 'wait_agent',
    summary:
      'Wait at an explicit dependency barrier until one Subagent is terminal.',
    details:
      'Use only when the next Primary step depends on this result. To wait for independent Agents together, issue multiple wait_agent Commands in the same Command Run step. A timeout returns timed_out and leaves the Agent running.',
    aliases: [],
    risk: 'readonly',
    invocation: cliInput(commandInput(schema), {
      positionals: [{ field: 'agent_id', metavar: 'agent' }],
      options: ['timeout_ms'],
    }),
    effects: () => ({
      ...AGENT_CONTROL_EFFECTS,
      concurrencySafe: true,
      readOnly: true,
      destructive: false,
      interruptible: true,
      telemetryTag: 'agent.wait',
    }),
    execution: {
      kind: 'immediate',
      run: async ({ agent_id, timeout_ms }, context) => {
        assertAgentSelector(agent_id);
        const timeoutMs = timeout_ms ?? DEFAULT_AGENT_WAIT_TIMEOUT_MS;
        const waited = await input.service.wait(
          agent_id,
          input.request.threadId,
          context.signal,
          timeoutMs,
        );
        return waited.waitStatus === 'timed_out'
          ? {
              waitStatus: waited.waitStatus,
              timeoutMs,
              agent: agentView(waited.task),
            }
          : agentView(waited.task);
      },
    },
  });
}

function createStopAgentCommand(
  input: SubagentCommandInput,
): CommandDefinition {
  const schema = agentSelectorSchema();
  return defineCommand({
    name: 'stop_agent',
    summary:
      'Stop one queued or running Subagent; terminal Agents are unchanged.',
    aliases: [],
    risk: 'workspace-write',
    invocation: cliInput(commandInput(schema), {
      positionals: [{ field: 'agent_id', metavar: 'agent' }],
    }),
    approval: input.approval('stop_agent'),
    effects: () => ({
      ...AGENT_CONTROL_EFFECTS,
      concurrencySafe: false,
      readOnly: false,
      destructive: false,
      interruptible: false,
      telemetryTag: 'agent.stop',
    }),
    execution: {
      kind: 'immediate',
      run: async ({ agent_id }) => {
        assertAgentSelector(agent_id);
        return agentView(
          await input.service.stop(agent_id, input.request.threadId),
        );
      },
    },
  });
}

function agentSelectorSchema() {
  return z
    .object({
      agent_id: agentSelectorField(),
    })
    .strict();
}

function agentSelectorField() {
  return z
    .string()
    .trim()
    .min(1)
    .describe('Subagent job_ id, agent_ id, or root-thread-local name.');
}

function readonlyEffects(telemetryTag: string) {
  return () => ({
    ...AGENT_CONTROL_EFFECTS,
    concurrencySafe: true,
    readOnly: true,
    destructive: false,
    interruptible: true,
    telemetryTag,
  });
}

function spawnDescription(
  candidates: readonly CodingAgentDefinition[],
  policy: 'workspace' | 'allowed_paths',
  authorizedRoots: readonly string[],
): string {
  const catalog = candidates
    .map((candidate) => `- ${candidate.name}: ${candidate.description}`)
    .join('\n');
  return [
    'Delegation is always asynchronous and every Subagent receives an independent context built only from this Task Packet and stable project context.',
    `cwd policy: ${policy}. Omit cwd to use the Primary working directory.`,
    `Authorized cwd roots: ${authorizedRoots.join(', ')}`,
    'Available Subagents:',
    catalog,
  ].join('\n');
}

function assertAgentSelector(selector: string): void {
  if (
    !/^\d+$/u.test(selector) &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      selector,
    )
  ) {
    return;
  }
  throw new Error(
    `Task '${selector}' is a Task Board id; Agent Commands accept only job_ ids, agent_ ids, or local Agent names.`,
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

function oneLine(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 159)}…`;
}

function agentView(task: AgentTask) {
  return {
    taskId: task.id,
    agentId: task.agentId,
    ...(task.name === undefined ? {} : { name: task.name }),
    agent: task.definitionName,
    description: task.description,
    status: task.status,
    cwd: task.cwd,
    revision: task.revision,
    ...(task.result === undefined ? {} : { result: task.result }),
    ...(task.errorMessage === undefined ? {} : { error: task.errorMessage }),
    ...(task.usage === undefined ? {} : { usage: task.usage }),
  };
}
