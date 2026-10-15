/**
 * Command Registry、Catalog 编译与内置发现调用能力。
 *
 * 本模块只消费 Command 原生定义。CLI parser、Usage、模型说明、搜索索引和执行绑定均由
 * 同一份 definition 编译，不再按名称适配旧 Tool。
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  cliInput,
  commandInput,
  defineCommand,
  immediate,
  structuredInput,
  type CommandDefinition,
  type CommandExample,
  type CommandExampleFrame,
  type CommandModule,
} from './definition.js';
import { compileInvocation, type CompiledInvocation } from './invocation.js';
import type {
  CommandApprovalDecision,
  CommandCapabilities,
  CommandContext,
  CommandFrame,
  CompiledCommandFrame,
  CommandRunResult,
} from './types.js';

const BUILTIN_COMMAND_NAMES = new Set([
  'command_run',
  'command_search',
  'command_invoke',
]);

export interface CatalogCommand {
  readonly definition: CommandDefinition;
  readonly invocation: CompiledInvocation;
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly examples: readonly CommandExample[];
  /** 把已解析输入绑定为可执行 Command。 */
  resolve(input: unknown): ResolvedCommand;
}

export interface CommandRegistrySnapshot {
  readonly inline: ReadonlyMap<string, CatalogCommand>;
  readonly discoverable: ReadonlyMap<string, CatalogCommand>;
  readonly revision: string;
}

export interface ResolvedCommand {
  readonly physicalName: string;
  readonly logicalName: string;
  readonly input: unknown;
  readonly deferred: boolean;
  /** 解析当前上下文中的执行能力。 */
  capabilities(context: CommandContext): Promise<CommandCapabilities>;
  /** 执行 Command 自定义校验。 */
  validate(context: CommandContext): Promise<void>;
  /** 计算归一化审批决策。 */
  approval(context: CommandContext): Promise<NormalizedApproval>;
  /** 执行已经校验和审批的 Command。 */
  execute(context: CommandContext): Promise<unknown>;
}

export interface NormalizedApproval {
  readonly action: 'auto' | 'required' | 'denied';
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CommandRegistryOptions {
  readonly modules: readonly CommandModule[];
  readonly search: {
    readonly resultLimit: number;
    readonly maxResultBytes: number;
  };
}

/** 根据当前 Command modules 创建不可变 Registry 快照。 */
export function createCommandRegistrySnapshot(
  options: CommandRegistryOptions,
): CommandRegistrySnapshot {
  const modules = validateModules(options.modules);
  const definitions = uniqueDefinitions(
    modules.flatMap((module) =>
      [...module.commands].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    ),
  );
  const compiled = definitions.map(compileDefinition);
  const discoverable = new Map(
    compiled
      .filter((command) => command.definition.exposure === 'discoverable')
      .map((command) => [command.name, command]),
  );
  const inline = compiled.filter(
    (command) => command.definition.exposure === 'inline',
  );
  const search = compileDefinition(
    commandSearchDefinition(discoverable, options.search),
  );
  const invoke = commandInvokeCommand(discoverable);
  const direct = new Map(
    [...inline, search, invoke]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((command) => [command.name, command]),
  );
  const commandRevisionSource = [...direct.values(), ...discoverable.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((command) => ({
      name: command.name,
      version: command.definition.version,
      summary: command.definition.summary,
      details: command.definition.details,
      aliases: command.definition.aliases,
      risk: command.definition.risk,
      exposure: command.definition.exposure,
      invocation: command.invocation.kind,
      inputSchema: command.invocation.inputJsonSchema,
      usage: command.usage,
      examples: command.examples,
      effects:
        typeof command.definition.effects === 'function'
          ? 'dynamic'
          : command.definition.effects,
      validate: command.definition.validate !== undefined,
      approval: command.definition.approval !== undefined,
      execution: command.definition.execution.kind,
    }));
  return {
    inline: direct,
    discoverable,
    revision: digest({
      modules: modules.map((module) => module.id),
      commands: commandRevisionSource,
    }),
  };
}

function validateModules(
  modules: readonly CommandModule[],
): readonly CommandModule[] {
  const ids = new Set<string>();
  return [...modules]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((module) => {
      if (!/^[a-z][a-z0-9-]*$/u.test(module.id)) {
        throw new Error(`Invalid Command module id '${module.id}'.`);
      }
      if (ids.has(module.id)) {
        throw new Error(`Duplicate Command module '${module.id}'.`);
      }
      ids.add(module.id);
      return module;
    });
}

/** 将 inline Catalog 渲染为随 provider Tool 定义发送的能力说明。 */
export function renderCatalogPrompt(
  catalog: ReadonlyMap<string, CatalogCommand>,
): string {
  const definitions = [...catalog.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return [
    ...renderFrameExamples(definitions),
    `Available commands: ${definitions.map((item) => item.name).join(', ')}.`,
    'Command details:',
    ...definitions.map((command) => {
      const docs = command.invocation.argumentDocs.map(
        (entry) => `    ${entry}`,
      );
      return [
        `- ${command.name}: ${command.description}`,
        `  Usage: ${command.usage}`,
        ...(docs.length === 0 ? [] : ['  Arguments:', ...docs]),
      ].join('\n');
    }),
  ].join('\n');
}

type ExampleChannel = 'args' | 'body' | 'input';

interface SelectedExample {
  readonly name: string;
  readonly frame: CommandExampleFrame;
}

/**
 * 为当前 Catalog 渲染每种参数通道各一个规范 Frame 示例。
 *
 * 示例只从真实 Command 定义中挑选，因此不会出现当前不可调用的 Command。
 */
function renderFrameExamples(
  definitions: readonly CatalogCommand[],
): readonly string[] {
  const batch = [
    selectExample(definitions, 'args'),
    selectExample(definitions, 'body'),
  ]
    .filter((example): example is SelectedExample => example !== undefined)
    .map((example, index) => frameJson(index + 1, example));
  const structured = selectExample(definitions, 'input');
  const lines = [
    ...(batch.length === 0
      ? []
      : [`  Batch: {"commands":[${batch.join(',')}]}`]),
    ...(structured === undefined
      ? []
      : [`  Object arguments: ${frameJson(1, structured)}`]),
  ];
  return lines.length === 0 ? [] : ['Frame examples:', ...lines, ''];
}

function selectExample(
  definitions: readonly CatalogCommand[],
  channel: ExampleChannel,
): SelectedExample | undefined {
  let selected: SelectedExample | undefined;
  let selectedScore = -1;
  for (const command of definitions) {
    for (const example of command.examples) {
      if (exampleChannel(example.frame) !== channel) continue;
      const score = exampleScore(example.frame);
      if (score <= selectedScore) continue;
      selected = { name: command.name, frame: example.frame };
      selectedScore = score;
    }
  }
  return selected;
}

function exampleChannel(frame: CommandExampleFrame): ExampleChannel {
  if (frame.input !== undefined) return 'input';
  return frame.body === undefined ? 'args' : 'body';
}

/** 优先选择同时演示 positional 与 option 的示例。 */
function exampleScore(frame: CommandExampleFrame): number {
  const args = frame.args ?? [];
  const positional = args.some((value, index) => {
    if (value.startsWith('-')) return false;
    const previous = args[index - 1];
    return previous === undefined || !previous.startsWith('-');
  });
  const option = args.some((value) => value.startsWith('--'));
  return (positional ? 2 : 0) + (option ? 1 : 0);
}

function frameJson(step: number, example: SelectedExample): string {
  const frame = example.frame;
  return JSON.stringify({
    step,
    command: example.name,
    ...(frame.args === undefined ? {} : { args: frame.args }),
    ...(frame.body === undefined ? {} : { body: frame.body }),
    ...(frame.input === undefined ? {} : { input: frame.input }),
  });
}

/** 在零副作用阶段把全部 Frame 编译为稳定的类型化 Command。 */
export function compileFrames(
  commandRunId: string,
  frames: readonly CommandFrame[],
  catalog: ReadonlyMap<string, CatalogCommand>,
): readonly CompiledCommandFrame[] {
  return frames.map((frame, index) => {
    const definition = catalog.get(frame.command);
    if (definition === undefined) {
      throw compileError(
        index,
        frame.command,
        `unknown command '${frame.command}'`,
      );
    }
    try {
      const input = definition.invocation.parseFrame(frame);
      return {
        index,
        step: frame.step,
        command: definition.name,
        input,
        inputDigest: digest(input),
        commandId: `${commandRunId}:${index}`,
        onFailure: frame.onFailure ?? 'stop',
      };
    } catch (error) {
      throw compileError(
        index,
        frame.command,
        errorMessage(error),
        definition.usage,
      );
    }
  });
}

/** 将 schema 或 Command 编译异常转换为模型可读的精确错误。 */
export function compileDetails(
  error: unknown,
): NonNullable<CommandRunResult['error']> {
  if (error instanceof CommandCompileError) {
    return {
      frameIndex: error.frameIndex,
      command: error.command,
      message: error.message,
      ...(error.usage === undefined ? {} : { usage: error.usage }),
    };
  }
  if (error instanceof z.ZodError) {
    const firstIssue = error.issues[0];
    const frameIndex =
      firstIssue?.path[0] === 'commands' &&
      typeof firstIssue.path[1] === 'number'
        ? firstIssue.path[1]
        : undefined;
    return {
      ...(frameIndex === undefined ? {} : { frameIndex }),
      message: error.issues.map(formatCommandRunSchemaIssue).join('; '),
    };
  }
  return { message: errorMessage(error) };
}

function formatCommandRunSchemaIssue(issue: z.core.$ZodIssue): string {
  const location = issue.path.join('.') || 'input';
  if (
    issue.code === 'unrecognized_keys' &&
    issue.path[0] === 'commands' &&
    typeof issue.path[1] === 'number'
  ) {
    return `${location}: ${issue.message}. Command Frame keys are step, command, args, body, input, and onFailure. Put CLI options such as --timeout-ms and their values in args.`;
  }
  return `${location}: ${issue.message}`;
}

/** 返回搜索结果与 revision 共用的 Command JSON Schema。 */
export function schemaFor(command: CommandDefinition): unknown {
  return command.invocation.input.jsonSchema;
}

/** 对键顺序稳定的 JSON 值计算 SHA-256 摘要。 */
export function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function uniqueDefinitions(
  commands: readonly CommandDefinition[],
): readonly CommandDefinition[] {
  const names = new Set<string>();
  const searchTerms = new Map<string, string>();
  return commands.map((command) => {
    if (!/^[a-z][a-z0-9_]*$/u.test(command.name)) {
      throw new Error(`Invalid Command name '${command.name}'.`);
    }
    if (BUILTIN_COMMAND_NAMES.has(command.name)) {
      throw new Error(`Command name '${command.name}' is reserved.`);
    }
    if (names.has(command.name)) {
      throw new Error(`Duplicate Command '${command.name}'.`);
    }
    if (!Number.isInteger(command.version) || command.version < 1) {
      throw new Error(`Command '${command.name}' has an invalid version.`);
    }
    if (command.summary.trim() === '') {
      throw new Error(`Command '${command.name}' has an empty summary.`);
    }
    for (const term of [command.name, ...command.aliases]) {
      const normalized = term.trim().toLocaleLowerCase();
      if (normalized === '') {
        throw new Error(`Command '${command.name}' has an empty alias.`);
      }
      if (BUILTIN_COMMAND_NAMES.has(normalized)) {
        throw new Error(
          `Command search term '${term}' is reserved by built-in '${normalized}'.`,
        );
      }
      const owner = searchTerms.get(normalized);
      if (owner !== undefined) {
        throw new Error(
          `Command search term '${term}' collides between '${owner}' and '${command.name}'.`,
        );
      }
      searchTerms.set(normalized, command.name);
    }
    if (
      command.exposure === 'discoverable' &&
      command.invocation.kind !== 'structured'
    ) {
      throw new Error(
        `Discoverable Command '${command.name}' must use structured input.`,
      );
    }
    names.add(command.name);
    return command;
  });
}

function compileDefinition(definition: CommandDefinition): CatalogCommand {
  const invocation = compileInvocation(definition);
  const examples = compileExamples(definition, invocation);
  return {
    definition,
    invocation,
    name: definition.name,
    description: [definition.summary.trim(), definition.details?.trim()]
      .filter((value): value is string => value !== undefined && value !== '')
      .join(' '),
    usage: invocation.usage,
    examples,
    resolve(input) {
      return resolveDefinition(definition, input, definition.name);
    },
  };
}

function compileExamples(
  definition: CommandDefinition,
  invocation: CompiledInvocation,
): readonly CommandExample[] {
  return definition.examples.map((example, index) => {
    if (example.description.trim() === '') {
      throw new Error(
        `Command '${definition.name}' example ${index + 1} has an empty description.`,
      );
    }
    const unsupportedKeys = Object.keys(example.frame).filter(
      (key) => !['args', 'body', 'input'].includes(key),
    );
    if (unsupportedKeys.length > 0) {
      throw new Error(
        `Command '${definition.name}' example ${index + 1} has unsupported Frame fields: ${unsupportedKeys.join(', ')}.`,
      );
    }
    try {
      invocation.parseFrame({
        step: 1,
        command: definition.name,
        ...example.frame,
      });
    } catch (error) {
      throw new Error(
        `Command '${definition.name}' example ${index + 1} is invalid: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    return Object.freeze({
      description: example.description.trim(),
      frame: Object.freeze({ ...example.frame }),
    });
  });
}

function resolveDefinition(
  definition: CommandDefinition,
  input: unknown,
  physicalName: string,
): ResolvedCommand {
  return {
    physicalName,
    logicalName: definition.name,
    input,
    deferred: definition.execution.kind === 'deferred',
    async capabilities(context) {
      const declared =
        typeof definition.effects === 'function'
          ? await definition.effects(input, context)
          : definition.effects;
      const defaultReadOnly = definition.risk === 'readonly';
      const readOnly = declared?.readOnly ?? defaultReadOnly;
      const destructive =
        declared?.destructive ?? definition.risk !== 'readonly';
      return {
        logicalName: definition.name,
        usesEnvironment: declared?.usesEnvironment !== false,
        concurrencySafe:
          declared?.concurrencySafe === true && readOnly && !destructive,
        readOnly,
        destructive,
        interruptible: declared?.interruptible === true,
        enabled: declared?.enabled !== false,
        telemetryTag: declared?.telemetryTag ?? definition.name,
      };
    },
    async validate(context) {
      await definition.validate?.(input, context);
    },
    async approval(context) {
      return normalizeApproval(await definition.approval?.(input, context));
    },
    async execute(context) {
      if (definition.execution.kind === 'deferred') {
        throw new Error(
          `Deferred Command '${definition.name}' requires a host result.`,
        );
      }
      return definition.execution.run(input, context);
    },
  };
}

function commandSearchDefinition(
  targets: ReadonlyMap<string, CatalogCommand>,
  limits: CommandRegistryOptions['search'],
): CommandDefinition {
  const schema = z
    .object({
      query: z
        .string()
        .trim()
        .optional()
        .describe(
          'Optional text matched against names, aliases and docs; omit it or pass an empty string to list all Commands.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(limits.resultLimit)
        .default(limits.resultLimit)
        .describe('Maximum number of matching Commands to return.'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Zero-based result offset for pagination.'),
    })
    .strict();
  return defineCommand({
    name: 'command_search',
    summary:
      'Search discoverable Commands and return their names and input schemas.',
    examples: [
      {
        description: 'Search discoverable Commands',
        frame: { args: ['--query', 'delegate'] },
      },
    ],
    aliases: [],
    risk: 'readonly',
    invocation: cliInput(commandInput(schema), {
      options: ['query', 'limit', 'offset'],
    }),
    effects: {
      usesEnvironment: false,
      concurrencySafe: true,
      readOnly: true,
      destructive: false,
      interruptible: true,
      telemetryTag: 'command.search',
    },
    execution: immediate(async (input: z.infer<typeof schema>) => {
      const normalized = input.query?.toLocaleLowerCase();
      const matches = [...targets.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .filter((target) => {
          if (normalized === undefined || normalized === '') return true;
          return [
            target.name,
            target.description,
            ...target.definition.aliases,
            stableJson(target.invocation.inputJsonSchema),
          ]
            .join(' ')
            .toLocaleLowerCase()
            .includes(normalized);
        });
      const selected = matches.slice(input.offset, input.offset + input.limit);
      const result = {
        results: selected.map((target) => ({
          name: target.name,
          summary: target.definition.summary,
          description: target.description,
          risk: target.definition.risk,
          inputSchema: target.invocation.inputJsonSchema,
        })),
        totalAvailableCommands: targets.size,
        offset: input.offset,
        truncated: input.offset + selected.length < matches.length,
        ...(input.offset + selected.length < matches.length
          ? { nextOffset: input.offset + selected.length }
          : {}),
      };
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (bytes > limits.maxResultBytes) {
        throw new Error(
          `command_search result is ${bytes} bytes, exceeding ${limits.maxResultBytes}. Narrow the query or limit.`,
        );
      }
      return result;
    }),
  });
}

function commandInvokeCommand(
  targets: ReadonlyMap<string, CatalogCommand>,
): CatalogCommand {
  const schema = z
    .object({
      name: z
        .string()
        .trim()
        .min(1)
        .describe('Exact name of a discoverable Command.'),
      arguments: z
        .record(z.string(), z.unknown())
        .describe(
          'Object arguments matching the inputSchema that command_search returned for that Command.',
        ),
    })
    .strict();
  const definition = defineCommand({
    name: 'command_invoke',
    summary:
      'Invoke one discoverable Command returned by command_search, using its own input schema.',
    examples: [
      {
        description: 'Invoke a discoverable Command',
        frame: {
          input: { name: '<command_search result>', arguments: {} },
        },
      },
    ],
    aliases: [],
    risk: 'external',
    invocation: structuredInput(commandInput(schema)),
    execution: immediate(() => {
      throw new Error('command_invoke must resolve its target before execute.');
    }),
  });
  const compiled = compileDefinition(definition);
  return {
    ...compiled,
    resolve(input) {
      const parsed = schema.parse(input);
      const target = targets.get(parsed.name);
      if (target === undefined) {
        throw new Error(
          `unknown or recursive discoverable Command '${parsed.name}'`,
        );
      }
      const targetInput = target.invocation.parseStructured(parsed.arguments);
      return resolveDefinition(
        target.definition,
        targetInput,
        'command_invoke',
      );
    },
  };
}

function normalizeApproval(
  decision: CommandApprovalDecision | undefined,
): NormalizedApproval {
  if (decision === undefined) return { action: 'auto' };
  if (typeof decision === 'string') return { action: decision };
  return {
    action: decision.action,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(decision.metadata === undefined ? {} : { metadata: decision.metadata }),
  };
}

class CommandCompileError extends Error {
  override readonly name = 'CommandCompileError';

  constructor(
    readonly frameIndex: number,
    readonly command: string,
    message: string,
    readonly usage?: string,
  ) {
    super(message);
  }
}

function compileError(
  frameIndex: number,
  command: string,
  message: string,
  usage?: string,
): CommandCompileError {
  return new CommandCompileError(frameIndex, command, message, usage);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
