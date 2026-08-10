/**
 * Command invocation 编译器。
 *
 * CLI 解析委托给 Node `util.parseArgs`；本模块只实现 schema 字段映射、严格语法收窄、
 * 标量转换、Usage 和参数文档生成。
 */
import { parseArgs } from 'node:util';

import { ZodError } from 'zod';

import type {
  CommandCliInvocation,
  CommandDefinition,
  CommandInvocation,
} from './definition.js';
import type { CommandFrame } from './types.js';

interface JsonSchemaNode {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly items?: JsonSchemaNode;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface CompiledInvocation {
  readonly kind: CommandInvocation<unknown>['kind'];
  readonly usage: string;
  readonly argumentDocs: readonly string[];
  readonly inputJsonSchema: Readonly<Record<string, unknown>>;
  /** 解析模型提交的 Command Frame。 */
  parseFrame(frame: CommandFrame): unknown;
  /** 解析 command_invoke 提交的结构化输入。 */
  parseStructured(value: unknown): unknown;
}

/**
 * 编译一个 Command invocation，并在 Registry 构造期验证字段映射。
 *
 * Args:
 * - `definition`: 尚未编译的 Command 原生定义。
 *
 * Returns:
 * - 返回可直接解析 Frame、渲染 Usage 和公开 schema 的编译结果。
 */
export function compileInvocation(
  definition: CommandDefinition,
): CompiledInvocation {
  return definition.invocation.kind === 'structured'
    ? compileStructured(definition)
    : compileCli(definition, definition.invocation);
}

function compileStructured(definition: CommandDefinition): CompiledInvocation {
  const invocation = definition.invocation;
  if (invocation.kind !== 'structured') {
    throw new Error(`Command '${definition.name}' is not structured.`);
  }
  return {
    kind: 'structured',
    usage: renderStructuredUsage(
      definition.name,
      invocation.input.jsonSchema as JsonSchemaNode,
    ),
    argumentDocs: schemaArgumentDocs(invocation.input.jsonSchema),
    inputJsonSchema: invocation.input.jsonSchema,
    parseFrame(frame) {
      if (frame.args !== undefined || frame.body !== undefined) {
        throw new Error('input is mutually exclusive with args and body');
      }
      if (frame.input === undefined) throw new Error('input is required');
      return parseSchema(definition.name, invocation.input.schema, frame.input);
    },
    parseStructured(value) {
      return parseSchema(definition.name, invocation.input.schema, value);
    },
  };
}

function renderStructuredUsage(name: string, schema: JsonSchemaNode): string {
  const fields = Object.keys(schema.properties ?? {});
  const shape = fields.length === 0 ? '{}' : `{ ${fields.join(', ')} }`;
  return `${name} with input ${shape}; do not use args or body`;
}

function compileCli(
  definition: CommandDefinition,
  invocation: CommandCliInvocation<unknown>,
): CompiledInvocation {
  const root = invocation.input.jsonSchema as JsonSchemaNode;
  const properties = root.properties;
  if (root.type !== 'object' || properties === undefined) {
    throw new Error(
      `CLI Command '${definition.name}' requires an object input schema.`,
    );
  }
  const positionalFields = invocation.positionals.map((entry) => entry.field);
  const optionFields = [...invocation.options];
  assertFieldDescriptions(definition.name, properties);
  const mapped = [
    ...positionalFields,
    ...optionFields,
    ...(invocation.body === undefined ? [] : [invocation.body]),
  ];
  assertFieldMapping(definition.name, properties, mapped);
  const optionEntries = optionFields.map((field) => {
    const schema = requireProperty(definition.name, properties, field);
    assertCliProperty(definition.name, field, schema, true);
    return {
      field,
      flag: kebabCase(field),
      multiple: schema.type === 'array',
      schema,
    };
  });
  const flags = new Set<string>();
  for (const entry of optionEntries) {
    if (flags.has(entry.flag)) {
      throw new Error(
        `CLI Command '${definition.name}' has duplicate option '--${entry.flag}'.`,
      );
    }
    flags.add(entry.flag);
  }
  for (const entry of invocation.positionals) {
    assertCliProperty(
      definition.name,
      entry.field,
      requireProperty(definition.name, properties, entry.field),
      false,
    );
  }
  if (invocation.body !== undefined) {
    const bodySchema = requireProperty(
      definition.name,
      properties,
      invocation.body,
    );
    if (bodySchema.type !== 'string') {
      throw new Error(
        `CLI Command '${definition.name}' body field '${invocation.body}' must be a string.`,
      );
    }
  }
  const usage = renderUsage(definition.name, invocation, root, properties);
  const argumentDocs = renderArgumentDocs(invocation, root, properties);
  return {
    kind: 'cli',
    usage,
    argumentDocs,
    inputJsonSchema: invocation.input.jsonSchema,
    parseFrame(frame) {
      if (frame.input !== undefined) {
        throw cliInvocationError(
          definition.name,
          'input is not allowed for this CLI Command',
          usage,
        );
      }
      if (invocation.body === undefined && frame.body !== undefined) {
        throw cliInvocationError(definition.name, 'body is not allowed', usage);
      }
      const args = frame.args ?? [];
      const options = Object.fromEntries(
        optionEntries.map((entry) => [
          entry.flag,
          { type: 'string' as const, multiple: entry.multiple },
        ]),
      );
      const parsed = (() => {
        try {
          return parseArgs({
            args: [...args],
            options,
            allowPositionals: true,
            strict: true,
            tokens: true,
          });
        } catch (error) {
          throw cliInvocationError(
            definition.name,
            error instanceof Error ? error.message : String(error),
            usage,
          );
        }
      })();
      for (const token of parsed.tokens) {
        if (token.kind === 'option' && token.inlineValue) {
          throw cliInvocationError(
            definition.name,
            `option '${token.rawName}' must use a separate value token`,
            usage,
          );
        }
      }
      const scalarOptions = new Set(
        optionEntries
          .filter((entry) => !entry.multiple)
          .map((entry) => entry.flag),
      );
      const seenScalarOptions = new Set<string>();
      for (const token of parsed.tokens) {
        if (token.kind !== 'option' || !scalarOptions.has(token.name)) continue;
        if (seenScalarOptions.has(token.name)) {
          throw cliInvocationError(
            definition.name,
            `option '--${token.name}' cannot be repeated`,
            usage,
          );
        }
        seenScalarOptions.add(token.name);
      }
      if (parsed.positionals.length > invocation.positionals.length) {
        const unexpected = parsed.positionals[invocation.positionals.length];
        throw cliInvocationError(
          definition.name,
          `unexpected positional argument '${unexpected ?? ''}'`,
          usage,
        );
      }
      const value: Record<string, unknown> = {};
      invocation.positionals.forEach((entry, index) => {
        const raw = parsed.positionals[index];
        if (raw === undefined) return;
        value[entry.field] = decodeScalar(
          definition.name,
          entry.field,
          raw,
          requireProperty(definition.name, properties, entry.field),
        );
      });
      for (const entry of optionEntries) {
        const raw = parsed.values[entry.flag];
        if (raw === undefined) continue;
        value[entry.field] = entry.multiple
          ? (raw as string[]).map((item) =>
              decodeScalar(
                definition.name,
                entry.field,
                item,
                entry.schema.items ?? {},
              ),
            )
          : decodeScalar(
              definition.name,
              entry.field,
              raw as string,
              entry.schema,
            );
      }
      if (invocation.body !== undefined && frame.body !== undefined) {
        value[invocation.body] = frame.body;
      }
      return parseSchema(definition.name, invocation.input.schema, value);
    },
    parseStructured(value) {
      return parseSchema(definition.name, invocation.input.schema, value);
    },
  };
}

function cliInvocationError(
  command: string,
  message: string,
  usage: string,
): Error {
  const positionalHint = message.startsWith('unexpected positional argument')
    ? '; options shown as --name in Usage must be separate flag/value entries in args'
    : '';
  return new Error(
    `${message} for '${command}'; usage: ${usage}${positionalHint}`,
  );
}

function assertFieldDescriptions(
  command: string,
  properties: Readonly<Record<string, JsonSchemaNode>>,
): void {
  const missing = Object.entries(properties)
    .filter(
      ([, schema]) =>
        typeof schema.description !== 'string' ||
        schema.description.trim() === '',
    )
    .map(([field]) => field);
  if (missing.length > 0) {
    throw new Error(
      `CLI Command '${command}' has fields without descriptions: ${missing.join(', ')}.`,
    );
  }
}

function assertFieldMapping(
  command: string,
  properties: Readonly<Record<string, JsonSchemaNode>>,
  mapped: readonly string[],
): void {
  const seen = new Set<string>();
  for (const field of mapped) {
    if (properties[field] === undefined) {
      throw new Error(
        `CLI Command '${command}' maps unknown schema field '${field}'.`,
      );
    }
    if (seen.has(field)) {
      throw new Error(
        `CLI Command '${command}' maps field '${field}' more than once.`,
      );
    }
    seen.add(field);
  }
  const unbound = Object.keys(properties).filter((field) => !seen.has(field));
  if (unbound.length > 0) {
    throw new Error(
      `CLI Command '${command}' has unbound fields: ${unbound.join(', ')}.`,
    );
  }
}

function assertCliProperty(
  command: string,
  field: string,
  schema: JsonSchemaNode,
  allowArray: boolean,
): void {
  const scalar = ['string', 'number', 'integer', 'boolean'].includes(
    typeof schema.type === 'string' ? schema.type : '',
  );
  const scalarArray =
    allowArray &&
    schema.type === 'array' &&
    schema.items !== undefined &&
    ['string', 'number', 'integer', 'boolean'].includes(
      typeof schema.items.type === 'string' ? schema.items.type : '',
    );
  if (!scalar && !scalarArray) {
    throw new Error(
      `CLI Command '${command}' field '${field}' is not a supported scalar${
        allowArray ? ' or scalar array' : ''
      }.`,
    );
  }
}

function decodeScalar(
  command: string,
  field: string,
  value: string,
  schema: JsonSchemaNode,
): unknown {
  if (schema.type === 'integer') {
    if (!/^-?\d+$/u.test(value)) {
      throw new Error(`'${field}' for '${command}' must be an integer`);
    }
    return Number.parseInt(value, 10);
  }
  if (schema.type === 'number') {
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) {
      throw new Error(`'${field}' for '${command}' must be a number`);
    }
    const parsed = Number(value);
    return parsed;
  }
  if (schema.type === 'boolean') {
    if (value !== 'true' && value !== 'false') {
      throw new Error(`'${field}' for '${command}' must be true or false`);
    }
    return value === 'true';
  }
  return value;
}

function renderUsage(
  name: string,
  invocation: CommandCliInvocation<unknown>,
  root: JsonSchemaNode,
  properties: Readonly<Record<string, JsonSchemaNode>>,
): string {
  const parts = [name];
  for (const entry of invocation.positionals) {
    const metavar = entry.metavar ?? kebabCase(entry.field);
    const schema = requireProperty(name, properties, entry.field);
    parts.push(
      mustProvide(schema, root, entry.field)
        ? `<${metavar}>`
        : `[<${metavar}>]`,
    );
  }
  for (const field of invocation.options) {
    const schema = requireProperty(name, properties, field);
    const value = schema.type === 'array' ? (schema.items ?? {}) : schema;
    const option = `--${kebabCase(field)} <${typeLabel(value)}>`;
    const rendered = mustProvide(schema, root, field) ? option : `[${option}]`;
    parts.push(schema.type === 'array' ? `${rendered}...` : rendered);
  }
  if (invocation.body !== undefined) {
    const schema = requireProperty(name, properties, invocation.body);
    parts.push(
      mustProvide(schema, root, invocation.body) ? 'with body' : '[with body]',
    );
  }
  return parts.join(' ');
}

function renderArgumentDocs(
  invocation: CommandCliInvocation<unknown>,
  root: JsonSchemaNode,
  properties: Readonly<Record<string, JsonSchemaNode>>,
): readonly string[] {
  const docs: string[] = [];
  for (const entry of invocation.positionals) {
    const schema = requireProperty('CLI', properties, entry.field);
    docs.push(
      `<${entry.metavar ?? kebabCase(entry.field)}>: ${describeField(
        schema,
        mustProvide(schema, root, entry.field),
      )}`,
    );
  }
  for (const field of invocation.options) {
    const schema = requireProperty('CLI', properties, field);
    docs.push(
      `--${kebabCase(field)}: ${describeField(
        schema,
        mustProvide(schema, root, field),
      )}`,
    );
  }
  if (invocation.body !== undefined) {
    const schema = requireProperty('CLI', properties, invocation.body);
    docs.push(
      `body: ${describeField(
        schema,
        mustProvide(schema, root, invocation.body),
      )}`,
    );
  }
  return docs;
}

function schemaArgumentDocs(
  schema: Readonly<Record<string, unknown>>,
): readonly string[] {
  const root = schema as JsonSchemaNode;
  return Object.entries(root.properties ?? {}).map(
    ([field, property]) =>
      `${field}: ${describeField(property, mustProvide(property, root, field))}`,
  );
}

/** 判断模型是否必须显式提供该字段；带 default 的字段由 runtime 补齐。 */
function mustProvide(
  schema: JsonSchemaNode,
  root: JsonSchemaNode,
  field: string,
): boolean {
  return (
    (root.required ?? []).includes(field) && schema.default === undefined
  );
}

function describeField(schema: JsonSchemaNode, required: boolean): string {
  const constraints = [
    required ? 'required' : 'optional',
    schema.default === undefined
      ? undefined
      : `default ${JSON.stringify(schema.default)}`,
    schema.enum === undefined
      ? undefined
      : `one of ${schema.enum.map(String).join(', ')}`,
    boundLabel('min', schema.minimum),
    boundLabel('max', schema.maximum),
    schema.type === 'array' ? 'repeatable' : undefined,
  ].filter((value): value is string => value !== undefined);
  return `${schema.description ?? 'No description.'} (${constraints.join('; ')})`;
}

/** 忽略 JS 安全整数边界：它是编码上限而不是领域约束。 */
function boundLabel(label: string, value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Math.abs(value) >= Number.MAX_SAFE_INTEGER
    ? undefined
    : `${label} ${value}`;
}

function typeLabel(schema: JsonSchemaNode): string {
  if (schema.enum !== undefined) return schema.enum.map(String).join('|');
  return typeof schema.type === 'string' ? schema.type : 'value';
}

function requireProperty(
  command: string,
  properties: Readonly<Record<string, JsonSchemaNode>>,
  field: string,
): JsonSchemaNode {
  const property = properties[field];
  if (property === undefined) {
    throw new Error(`Command '${command}' has no schema field '${field}'.`);
  }
  return property;
}

function parseSchema(
  command: string,
  schema: { parse(value: unknown): unknown },
  value: unknown,
): unknown {
  try {
    return schema.parse(value);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const message = error.issues
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid arguments for '${command}': ${message}`, {
      cause: error,
    });
  }
}

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/_/gu, '-')
    .toLowerCase();
}
