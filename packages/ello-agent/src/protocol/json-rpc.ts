/**
 * 本文件负责 Protocol 的“json-rpc”模块职责。
 *
 * 模块不持有可变运行状态；wire 数据以 unknown 进入并由 schema 或显式 parser 收窄。
 * 字段名称、判别值和错误语义属于跨进程协议，调用方不得绕过校验直接构造不完整值。
 */
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

/**
 * 执行 JSON-RPC 协议的 `json-rpc` 模块 定义的 `toRpcError` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `error`: 上游捕获的失败值；函数保留原始 cause 并转换为当前错误契约。
 *
 * Returns:
 * - 返回 `toRpcError` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
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
