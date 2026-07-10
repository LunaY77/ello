import {
  defineTool,
  type AgentEnvironment,
  type AgentStreamEvent,
  type AgentTool,
  type ModelAdapter,
} from '@ello/agent';
import { z } from 'zod';

import type { CodingAgentConfig } from '../config/index.js';
import {
  makeApprovalPolicy,
  type DecideApproval,
} from '../permission/policy.js';
import type { PermissionRule } from '../permissions.js';
import type { ProviderRegistry } from '../provider/index.js';
import type { JsonlSessionStore } from '../session/jsonl-store.js';

import { BackgroundJobStore } from './background-jobs.js';
import type { AgentRegistry } from './registry.js';
import { deriveSubagentPermission } from './subagent-permissions.js';
import { runSubagent } from './subagent-run.js';

/** delegate 工具上抛给会话运行时的产品事件回调。 */
export interface DelegateToolHooks {
  /** subagent 内核事件透传（带 runId），TUI 据此显示子代理状态。 */
  readonly onEvent: (runId: string, event: AgentStreamEvent) => void;
  readonly onStarted: (info: {
    readonly runId: string;
    readonly agentName: string;
    readonly description: string;
    readonly background: boolean;
    readonly startedAt: string;
  }) => void;
  readonly onCompleted: (info: {
    readonly runId: string;
    readonly output: string;
    readonly completedAt: string;
  }) => void;
  readonly onFailed: (info: {
    readonly runId: string;
    readonly error: string;
    readonly completedAt: string;
  }) => void;
}

/** {@link createDelegateTool} 的入参。 */
export interface CreateDelegateToolOptions {
  readonly registry: AgentRegistry;
  readonly config: CodingAgentConfig;
  readonly providerRegistry: ProviderRegistry;
  readonly session: JsonlSessionStore;
  /** 当前 parent sessionId 读取器（会话切换后变化，故用闭包）。 */
  readonly parentSessionId: () => string;
  /** 当前动态权限规则（来自 RulesStore），用于派生 child 规则与审批判定。 */
  readonly rules: () => readonly PermissionRule[];
  readonly backgroundJobs: BackgroundJobStore;
  readonly hooks: DelegateToolHooks;
  readonly modelAdapter?: ModelAdapter;
}

const DelegateInputSchema = z.object({
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  run_id: z.string().optional(),
  background: z.boolean().optional(),
});

type DelegateInput = z.infer<typeof DelegateInputSchema>;

/**
 * 产品级 `delegate_to_subagent` 工具。
 *
 * 委派 = parent session 范围内的 sidechain run：按定义 role 解析模型、派生权限、
 * 转发事件。foreground 等 subagent 结束返回 `<subagent_run>` 信封；
 * background 立即返回 running，完成后由会话运行时注入 parent。
 */
export function createDelegateTool(
  options: CreateDelegateToolOptions,
): AgentTool<DelegateInput, string> {
  const delegatable = options.registry.delegatable();
  const decide: DecideApproval = makeApprovalPolicy(
    options.config,
    options.rules,
  );
  const description = [
    'Delegate a self-contained side task to a named subagent running in a parent-scoped sidechain.',
    '',
    'Use this when independent exploration, review, verification, or narrow implementation can proceed without blocking your core reasoning.',
    'Do not use it to delegate understanding of the user request, to avoid reading the code yourself, or for tiny tasks cheaper to do directly.',
    'Do not repeat delegated work after the subagent returns unless its result is missing, failed, or contradicted by source evidence.',
    '',
    'Prompt requirements:',
    '- include the exact objective, scope, relevant paths, constraints, and expected report format;',
    '- state whether writes are allowed;',
    '- include validation expectations for verify or implement workers;',
    '- keep secrets and unrelated user context out of the prompt.',
    '',
    'Lifecycle:',
    '- foreground tasks block until the subagent returns;',
    '- background tasks return immediately and the completed result is injected automatically;',
    '- do not poll background tasks;',
    '- use run_id only to continue the same subagent session;',
    '- subagent results are not shown directly to the user; the parent agent must summarize and integrate them.',
    '',
    'Available subagents:',
    ...delegatable.map((def) => `- ${def.name}: ${def.description}`),
  ].join('\n');

  return defineTool({
    name: 'delegate_to_subagent',
    description,
    input: DelegateInputSchema,
    approval: (input: DelegateInput, ctx) =>
      decide(
        {
          permission: 'task',
          patterns: [input.name],
          always: [input.name],
          metadata: {
            kind: 'task',
            agentName: input.name,
            description: input.description,
            background: input.background ?? false,
          },
        },
        ctx,
      ),
    execute: async (input: DelegateInput, ctx) => {
      const definition = options.registry.get(input.name);
      if (!delegatable.some((def) => def.name === input.name)) {
        throw new Error(`Agent is not delegatable: ${input.name}`);
      }
      const background = input.background ?? false;
      const parentSessionId = options.parentSessionId();
      const subagentRun = await runSubagent({
        definition,
        prompt: input.prompt,
        parentSessionId,
        ...(input.run_id !== undefined ? { runId: input.run_id } : {}),
        deps: {
          config: options.config,
          providerRegistry: options.providerRegistry,
          environment: ctx.environment as AgentEnvironment,
          permissionRules: deriveSubagentPermission(
            options.rules(),
            definition,
          ),
          ...(definition.maxTurns !== undefined
            ? { maxTurns: definition.maxTurns }
            : {}),
          ...(options.modelAdapter !== undefined
            ? { modelAdapter: options.modelAdapter }
            : {}),
        },
        onEvent: options.hooks.onEvent,
      });

      options.hooks.onStarted({
        runId: subagentRun.runId,
        agentName: input.name,
        description: input.description,
        background,
        startedAt: new Date().toISOString(),
      });

      if (background) {
        options.backgroundJobs.start(
          {
            id: subagentRun.runId,
            parentSessionId,
            agentName: input.name,
            title: input.description,
          },
          {
            final: subagentRun.final.then(
              (result) => result.output || result.text || '',
            ),
            abort: subagentRun.abort,
          },
        );
        return renderSubagentEnvelope({
          id: subagentRun.runId,
          agent: input.name,
          state: 'running',
          summary: input.description,
        });
      }

      try {
        const result = await subagentRun.final;
        const output = result.output || result.text || '';
        options.hooks.onCompleted({
          runId: subagentRun.runId,
          output,
          completedAt: new Date().toISOString(),
        });
        return renderSubagentEnvelope({
          id: subagentRun.runId,
          agent: input.name,
          state: 'completed',
          summary: input.description,
          result: output,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.hooks.onFailed({
          runId: subagentRun.runId,
          error: message,
          completedAt: new Date().toISOString(),
        });
        return renderSubagentEnvelope({
          id: subagentRun.runId,
          agent: input.name,
          state: 'error',
          summary: input.description,
          error: message,
        });
      }
    },
  });
}

/** 统一的 `<subagent_run>` 输出信封，供 parent 模型解析 sidechain 结果。 */
export function renderSubagentEnvelope(input: {
  readonly id: string;
  readonly agent: string;
  readonly state: 'running' | 'completed' | 'error' | 'cancelled';
  readonly summary: string;
  readonly result?: string;
  readonly error?: string;
}): string {
  const lines = [
    `<subagent_run id="${input.id}" agent="${input.agent}" state="${input.state}">`,
    `  <summary>${input.summary}</summary>`,
  ];
  if (input.result !== undefined) {
    lines.push(`  <result>${input.result}</result>`);
  }
  if (input.error !== undefined) {
    lines.push(`  <error>${input.error}</error>`);
  }
  lines.push('</subagent_run>');
  return lines.join('\n');
}
