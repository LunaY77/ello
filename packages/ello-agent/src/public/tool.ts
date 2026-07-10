import type { z } from 'zod';

import type { AgentError } from './agent.js';
import type { AgentEnvironment } from './environment.js';
import type { MaybePromise } from './model.js';

export interface AgentApprovalRequest {
  readonly id: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

export type AgentApprovalAction = 'auto' | 'required' | 'denied';
export type AgentApprovalDecision =
  | AgentApprovalAction
  | {
      readonly action: AgentApprovalAction;
      readonly reason?: string;
      readonly metadata?: Record<string, unknown>;
    };
export type AgentApprovalPolicy<TInput = unknown> = (
  input: TInput,
  ctx: AgentToolContext,
) => MaybePromise<AgentApprovalDecision>;

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<TInput>;
  execute(input: TInput, ctx: AgentToolContext): MaybePromise<TOutput>;
  approval?(
    input: TInput,
    ctx: AgentToolContext,
  ): MaybePromise<AgentApprovalDecision>;
  readonly inherit?: boolean;
}

export type AnyAgentTool = AgentTool<unknown, unknown>;

export interface AgentToolContext {
  readonly runId: string;
  readonly environment: AgentEnvironment;
  readonly metadata: Record<string, unknown>;
}

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: AgentError;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentSkill {
  readonly name: string;
  readonly displayName?: string | undefined;
  readonly description: string;
  readonly whenToUse?: string | undefined;
  readonly argumentHint?: string | undefined;
  readonly allowedTools?: readonly string[] | undefined;
  readonly context?: 'inline' | 'fork' | undefined;
  readonly model?: string | undefined;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | number | undefined;
  readonly userInvocable?: boolean | undefined;
  readonly disableModelInvocation?: boolean | undefined;
  readonly source?:
    | 'bundled'
    | 'global'
    | 'project'
    | 'shared'
    | 'mcp'
    | undefined;
  readonly baseDir?: string | undefined;
  readonly contentHash?: string | undefined;
  readonly instructions: string;
  readonly tools?: readonly AnyAgentTool[];
  readonly metadata?: Record<string, unknown>;
}

export interface DefineToolOptions<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<TInput>;
  readonly execute: (
    input: TInput,
    ctx: AgentToolContext,
  ) => MaybePromise<TOutput>;
  readonly approval?: AgentTool<TInput, TOutput>['approval'];
}

/** 定义类型由 Zod schema 推导的 Agent 工具。 */
export function defineTool<TInput, TOutput>(
  options: DefineToolOptions<TInput, TOutput>,
): AgentTool<TInput, TOutput> {
  return {
    name: options.name,
    description: options.description,
    input: options.input,
    execute: options.execute,
    ...(options.approval !== undefined ? { approval: options.approval } : {}),
  };
}
