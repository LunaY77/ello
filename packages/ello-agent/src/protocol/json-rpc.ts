import { z } from 'zod';

import { AppServerErrorTypeSchema, type AppServerError } from './errors.js';

export const RpcRequestIdSchema = z.union([z.string(), z.number().finite()]);
export type RpcRequestId = z.infer<typeof RpcRequestIdSchema>;

export const RpcErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: z
      .object({
        type: AppServerErrorTypeSchema,
        retryable: z.boolean(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const RpcRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: RpcRequestIdSchema,
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()),
  })
  .strict();

export const RpcNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()),
  })
  .strict();

const RpcSuccessResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: RpcRequestIdSchema,
    result: z.unknown(),
  })
  .strict();

const RpcFailureResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: RpcRequestIdSchema.nullable(),
    error: RpcErrorSchema,
  })
  .strict();

export const RpcResponseSchema = z.union([
  RpcSuccessResponseSchema,
  RpcFailureResponseSchema,
]);

export const RpcMessageSchema = z.union([
  RpcRequestSchema,
  RpcNotificationSchema,
  RpcResponseSchema,
]);

export type RpcError = z.infer<typeof RpcErrorSchema>;
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
export type RpcNotification = z.infer<typeof RpcNotificationSchema>;
export type RpcResponse = z.infer<typeof RpcResponseSchema>;
export type RpcMessage = z.infer<typeof RpcMessageSchema>;

export function toRpcError(error: AppServerError): RpcError {
  return {
    code: error.code,
    message: error.message,
    data: {
      type: error.type,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: { ...error.details } }),
    },
  };
}
