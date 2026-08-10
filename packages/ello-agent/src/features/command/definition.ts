/**
 * Command 原生定义、调用协议与类型擦除边界。
 *
 * Feature 通过 {@link defineCommand} 声明类型化能力；Registry 只消费擦除后的稳定定义，
 * 输入在 invocation schema 解析一次后才会进入 Effect、审批和执行回调。
 */
import type { z } from 'zod';

import type {
  CommandApprovalDecision,
  CommandCapabilities,
  CommandContext,
  JsonValue,
} from './types.js';

export type CommandRisk = 'readonly' | 'workspace-write' | 'external';
export type CommandExposure = 'inline' | 'discoverable';
export type MaybePromise<T> = T | Promise<T>;

export type CommandExampleFrame =
  | {
      readonly args?: readonly string[];
      readonly body?: string;
      readonly input?: never;
    }
  | {
      readonly args?: never;
      readonly body?: never;
      readonly input: Readonly<Record<string, JsonValue>>;
    };

export interface CommandExample {
  readonly description: string;
  readonly frame: CommandExampleFrame;
}

declare const commandInvocationInput: unique symbol;

interface CommandInvocationType {
  readonly kind: CommandInvocation<unknown>['kind'];
  readonly [commandInvocationInput]: unknown;
}

export interface CommandInputContract<TInput> {
  readonly schema: z.ZodType<TInput>;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
}

export interface CommandCliPositional<TInput> {
  readonly field: Extract<keyof TInput, string>;
  readonly metavar?: string;
}

export interface CommandCliInvocation<TInput> {
  readonly kind: 'cli';
  readonly [commandInvocationInput]: TInput;
  readonly input: CommandInputContract<TInput>;
  readonly positionals: readonly CommandCliPositional<TInput>[];
  readonly options: readonly Extract<keyof TInput, string>[];
  readonly body?: Extract<keyof TInput, string>;
}

export interface CommandStructuredInvocation<TInput> {
  readonly kind: 'structured';
  readonly [commandInvocationInput]: TInput;
  readonly input: CommandInputContract<TInput>;
}

export type CommandInvocation<TInput> =
  | CommandCliInvocation<TInput>
  | CommandStructuredInvocation<TInput>;

export type CommandExecution<TInput, TOutput> =
  | {
      readonly kind: 'immediate';
      readonly run: (
        input: TInput,
        context: CommandContext,
      ) => MaybePromise<TOutput>;
    }
  | { readonly kind: 'deferred' };

type InvocationInput<TInvocation extends CommandInvocationType> =
  TInvocation[typeof commandInvocationInput];

export interface DefineCommandOptions<
  TInvocation extends CommandInvocationType,
  TOutput,
> {
  readonly name: string;
  readonly version?: number;
  readonly summary: string;
  readonly details?: string;
  readonly examples?: readonly CommandExample[];
  readonly aliases?: readonly string[];
  readonly risk: CommandRisk;
  readonly exposure?: CommandExposure;
  readonly invocation: TInvocation;
  readonly effects?:
    | Partial<CommandCapabilities>
    | ((
        input: InvocationInput<TInvocation>,
        context: CommandContext,
      ) => MaybePromise<Partial<CommandCapabilities>>);
  /** 在任何副作用发生前校验类型化输入。 */
  readonly validate?: (
    input: NoInfer<InvocationInput<TInvocation>>,
    context: CommandContext,
  ) => MaybePromise<void>;
  /** 根据类型化输入和运行上下文返回审批决策。 */
  readonly approval?: (
    input: NoInfer<InvocationInput<TInvocation>>,
    context: CommandContext,
  ) => MaybePromise<CommandApprovalDecision>;
  readonly execution: CommandExecution<
    NoInfer<InvocationInput<TInvocation>>,
    TOutput
  >;
}

/** Registry 使用的类型擦除 Command 定义。 */
export interface CommandDefinition {
  readonly name: string;
  readonly version: number;
  readonly summary: string;
  readonly details?: string;
  readonly examples: readonly CommandExample[];
  readonly aliases: readonly string[];
  readonly risk: CommandRisk;
  readonly exposure: CommandExposure;
  readonly invocation: CommandInvocation<unknown>;
  readonly effects?:
    | Partial<CommandCapabilities>
    | ((
        input: unknown,
        context: CommandContext,
      ) => MaybePromise<Partial<CommandCapabilities>>);
  /** 在类型擦除边界执行 Command 自定义校验。 */
  readonly validate?: (
    input: unknown,
    context: CommandContext,
  ) => MaybePromise<void>;
  /** 在类型擦除边界计算 Command 审批决策。 */
  readonly approval?: (
    input: unknown,
    context: CommandContext,
  ) => MaybePromise<CommandApprovalDecision>;
  readonly execution:
    | {
        readonly kind: 'immediate';
        readonly run: (
          input: unknown,
          context: CommandContext,
        ) => MaybePromise<unknown>;
      }
    | { readonly kind: 'deferred' };
}

export interface CommandModule {
  readonly id: string;
  readonly commands: readonly CommandDefinition[];
}

/**
 * 构造由 Zod 校验并提供 JSON Schema 的 Command 输入契约。
 *
 * Args:
 * - `schema`: Command 输入的唯一类型和约束来源。
 *
 * Returns:
 * - 返回供 CLI 或 structured invocation 复用的输入契约。
 */
export function commandInput<TInput>(
  schema: z.ZodType<TInput>,
): CommandInputContract<TInput> {
  return {
    schema,
    jsonSchema: schema.toJSONSchema() as Readonly<Record<string, unknown>>,
  };
}

/**
 * 声明由位置参数、长 option 和可选 body 组成的 CLI invocation。
 *
 * Args:
 * - `input`: Zod 输入契约。
 * - `mapping`: schema 字段到 Frame args/body 的唯一映射。
 *
 * Returns:
 * - 返回尚未编译的类型化 CLI invocation。
 */
export function cliInput<TInput extends Record<string, unknown>>(
  input: CommandInputContract<TInput>,
  mapping: {
    readonly positionals?: readonly CommandCliPositional<TInput>[];
    readonly options?: readonly Extract<keyof TInput, string>[];
    readonly body?: Extract<keyof TInput, string>;
  } = {},
): CommandCliInvocation<TInput> {
  return {
    kind: 'cli',
    input,
    positionals: mapping.positionals ?? [],
    options: mapping.options ?? [],
    ...(mapping.body === undefined ? {} : { body: mapping.body }),
  } as CommandCliInvocation<TInput>;
}

/**
 * 声明直接从 Frame input 读取对象的 structured invocation。
 *
 * Args:
 * - `input`: Zod 或外部 JSON Schema 对应的输入契约。
 *
 * Returns:
 * - 返回严格排斥 args/body 的 structured invocation。
 */
export function structuredInput<TInput>(
  input: CommandInputContract<TInput>,
): CommandStructuredInvocation<TInput> {
  return { kind: 'structured', input } as CommandStructuredInvocation<TInput>;
}

/**
 * 声明立即执行的 Command 实现。
 *
 * Args:
 * - `run`: 接收已经类型化输入的领域执行函数。
 *
 * Returns:
 * - 返回 immediate execution 判别分支。
 */
export function immediate<TInput, TOutput>(
  run: (input: TInput, context: CommandContext) => MaybePromise<TOutput>,
): CommandExecution<TInput, TOutput> {
  return { kind: 'immediate', run };
}

/** 返回由宿主完成并通过 checkpoint 恢复的 deferred execution。 */
export function deferred<TInput>(): CommandExecution<TInput, never> {
  return { kind: 'deferred' };
}

/**
 * 定义一个 Command，并在此处完成泛型到 Registry 契约的安全擦除。
 *
 * Args:
 * - `options`: 名称、文档、invocation、Effect、审批与执行的单一声明。
 *
 * Returns:
 * - 返回可以直接放入 CommandModule 的稳定定义。
 */
export function defineCommand<
  TInvocation extends CommandInvocationType,
  TOutput,
>(options: DefineCommandOptions<TInvocation, TOutput>): CommandDefinition {
  type TInput = InvocationInput<TInvocation>;
  const effects = options.effects;
  const validate = options.validate;
  const approval = options.approval;
  const execution = options.execution;
  return {
    name: options.name,
    version: options.version ?? 1,
    summary: options.summary,
    ...(options.details === undefined ? {} : { details: options.details }),
    examples: options.examples ?? [],
    aliases: options.aliases ?? [],
    risk: options.risk,
    exposure: options.exposure ?? 'inline',
    invocation: options.invocation as unknown as CommandInvocation<unknown>,
    ...(effects === undefined
      ? {}
      : typeof effects === 'function'
        ? {
            effects: (input: unknown, context: CommandContext) =>
              effects(input as TInput, context),
          }
        : { effects }),
    ...(validate === undefined
      ? {}
      : {
          validate: (input: unknown, context: CommandContext) =>
            validate(input as TInput, context),
        }),
    ...(approval === undefined
      ? {}
      : {
          approval: (input: unknown, context: CommandContext) =>
            approval(input as TInput, context),
        }),
    execution:
      execution.kind === 'deferred'
        ? execution
        : {
            kind: 'immediate',
            run: (input: unknown, context: CommandContext) =>
              execution.run(input as TInput, context),
          },
  };
}

/**
 * 创建 feature 拥有的确定性 CommandModule。
 *
 * Args:
 * - `module`: feature id 与其完整 Command 定义集合。
 *
 * Returns:
 * - 返回不可变声明对象；Registry 负责重复与合法性校验。
 */
export function defineCommandModule(module: CommandModule): CommandModule {
  return Object.freeze({
    id: module.id,
    commands: Object.freeze([...module.commands]),
  });
}
