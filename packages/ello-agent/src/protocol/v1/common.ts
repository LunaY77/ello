/**
 * 本文件负责 Protocol 的“common”模块职责。
 *
 * 模块不持有可变运行状态；wire 数据以 unknown 进入并由 schema 或显式 parser 收窄。
 * 字段名称、判别值和错误语义属于跨进程协议，调用方不得绕过校验直接构造不完整值。
 */
import { z } from 'zod';

import { ELLO_PROTOCOL_VERSION } from '../version.js';

/**
 * 使用调用点选中的 Zod schema 解析 wire 值，并保留该 schema 的精确输出类型。
 *
 * Args:
 * - `schema`: 已由 method 映射选中的唯一运行时 schema；函数不修改 schema。
 * - `value`: 尚未信任的 JSON-RPC wire 值。
 *
 * Returns:
 * - 返回 schema 完成校验和 transform 后的精确输出类型。
 *
 * Throws:
 * - 值不满足 schema 时原样抛出 Zod 校验错误。
 */
export function parseSchema<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): z.output<TSchema> {
  return schema.parse(value);
}

/**
 * 按 method 从闭合 schema 表解析 wire 值，并维持 method 与输出类型的关联。
 *
 * Args:
 * - `schemas`: method 到 Zod schema 的闭合映射。
 * - `method`: 当前 wire 消息已经验证存在于映射中的 method。
 * - `value`: 尚未信任的 wire 值。
 *
 * Returns:
 * - 返回所选 method 对应 schema 的精确输出类型。
 *
 * Throws:
 * - method 对应 schema 拒绝输入时原样抛出 Zod 校验错误。
 */
export function parseSchemaMap<
  TSchemaMap extends Record<string, z.ZodType>,
  TMethod extends keyof TSchemaMap,
>(
  schemas: TSchemaMap,
  method: TMethod,
  value: unknown,
): z.output<TSchemaMap[TMethod]> {
  return parseSchema(schemas[method], value);
}

/**
 * 按 method 与字段从二级 schema 表解析 wire 值。
 *
 * Args:
 * - `schemas`: method 到 params/result schema 记录的闭合映射。
 * - `method`: 当前 Server Request method。
 * - `field`: 当前要解析的 `params` 或 `result` 字段。
 * - `value`: 尚未信任的 wire 值。
 *
 * Returns:
 * - 返回所选 method 与字段共同确定的 schema 输出类型。
 *
 * Throws:
 * - 对应 schema 拒绝输入时原样抛出 Zod 校验错误。
 */
export function parseNestedSchemaMap<
  TSchemaMap extends Record<
    string,
    { readonly params: z.ZodType; readonly result: z.ZodType }
  >,
  TMethod extends keyof TSchemaMap,
  TField extends 'params' | 'result',
>(
  schemas: TSchemaMap,
  method: TMethod,
  field: TField,
  value: unknown,
): z.output<TSchemaMap[TMethod][TField]> {
  const entry = schemas[method];
  if (entry === undefined) {
    throw new Error(`Unknown schema method: ${String(method)}`);
  }
  return parseSchema(entry[field], value);
}

export const EmptyParamsSchema = z.object({}).strict();
/**
 * Wire ID 允许 provider/model 常用的 `/`、`:`、`@` 等 opaque 字符，但拒绝
 * 反斜杠、空路径段和 `.`/`..` 路径段。落盘代码仍必须做独立的文件名校验。
 */
export const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^[A-Za-z0-9_@+-][A-Za-z0-9._~:@/+\-=]*$/u,
    'ID contains unsupported characters.',
  )
  .refine(
    (value) =>
      value
        .split('/')
        .every(
          (segment) => segment !== '' && segment !== '.' && segment !== '..',
        ),
    'ID must not contain path traversal segments.',
  );
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const PositiveIntegerSchema = z.number().int().positive();
export const ProtocolVersionSchema = z.literal(ELLO_PROTOCOL_VERSION);

export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const PaginationParamsSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();

export const CapabilitySchema = z.enum([
  'read',
  'submit',
  'approve',
  'write',
  'admin',
]);

export const SessionModeSchema = z.enum([
  'plan',
  'ask-before-changes',
  'accept-edits',
  'bypass',
]);

export const UsageSchema = z
  .object({
    requests: NonNegativeIntegerSchema,
    inputTokens: NonNegativeIntegerSchema,
    outputTokens: NonNegativeIntegerSchema,
    cacheReadTokens: NonNegativeIntegerSchema,
    cacheWriteTokens: NonNegativeIntegerSchema,
    toolCalls: NonNegativeIntegerSchema,
  })
  .strict();

export const UserInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('file'),
      path: z.string().min(1),
      displayName: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('image'),
      artifactId: OpaqueIdSchema,
      mediaType: z.string().min(1),
    })
    .strict(),
]);

export const ApprovalDecisionSchema = z
  .object({
    decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
  })
  .strict();

export const UserInputResolutionSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('submitted'),
      answers: z
        .array(
          z
            .object({
              questionId: z.string().min(1),
              selected: z.array(z.string().min(1)).min(1).readonly(),
              otherText: z.string().min(1).optional(),
            })
            .strict(),
        )
        .min(1)
        .readonly(),
    })
    .strict(),
  z.object({ status: z.literal('chat'), message: z.string().min(1) }).strict(),
  z.object({ status: z.literal('denied') }).strict(),
]);

export type Capability = z.infer<typeof CapabilitySchema>;
export type SessionMode = z.infer<typeof SessionModeSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type UserInput = z.infer<typeof UserInputSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type UserInputResolution = z.infer<typeof UserInputResolutionSchema>;

/**
 * 执行 JSON-RPC 协议的 `common` 模块 定义的 `cycleSessionMode` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `current`: `cycleSessionMode` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `bypassEnabled`: `cycleSessionMode` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `cycleSessionMode` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function cycleSessionMode(
  current: SessionMode,
  bypassEnabled: boolean,
): SessionMode {
  const modes: readonly SessionMode[] = bypassEnabled
    ? ['ask-before-changes', 'accept-edits', 'plan', 'bypass']
    : ['ask-before-changes', 'accept-edits', 'plan'];
  const index = modes.indexOf(current);
  if (index < 0) {
    throw new Error(`Cannot cycle unavailable session mode: ${current}`);
  }
  const next = modes[(index + 1) % modes.length];
  if (next === undefined) {
    throw new Error('Session mode cycle produced an invalid index.');
  }
  return next;
}
