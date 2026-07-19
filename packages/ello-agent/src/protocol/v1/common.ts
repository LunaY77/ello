import { z } from 'zod';

import { ELLO_PROTOCOL_VERSION } from '../version.js';

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
  return modes[(index + 1) % modes.length]!;
}
