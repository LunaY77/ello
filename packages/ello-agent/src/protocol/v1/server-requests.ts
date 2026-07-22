/**
 * 本文件负责 Protocol 的“server-requests”模块职责。
 *
 * 模块不持有可变运行状态；wire 数据以 unknown 进入并由 schema 或显式 parser 收窄。
 * 字段名称、判别值和错误语义属于跨进程协议，调用方不得绕过校验直接构造不完整值。
 */
import { z } from 'zod';

import {
  ApprovalDecisionSchema,
  OpaqueIdSchema,
  parseNestedSchemaMap,
  UserInputResolutionSchema,
} from './common.js';

const ServerRequestBaseShape = {
  threadId: OpaqueIdSchema,
  turnId: OpaqueIdSchema,
  itemId: OpaqueIdSchema,
  reason: z.string(),
};

const ApprovalParamsSchema = z
  .object({
    ...ServerRequestBaseShape,
    availableDecisions: z
      .array(z.enum(['accept', 'acceptForSession', 'decline', 'cancel']))
      .min(1)
      .readonly(),
  })
  .strict();

export const SERVER_REQUEST_SCHEMAS = {
  'item/commandExecution/requestApproval': {
    params: ApprovalParamsSchema.extend({
      command: z.array(z.string()).min(1).readonly(),
      cwd: z.string().min(1),
    }).strict(),
    result: ApprovalDecisionSchema,
  },
  'item/fileChange/requestApproval': {
    params: ApprovalParamsSchema.extend({
      paths: z.array(z.string().min(1)).min(1).readonly(),
      summary: z.string(),
    }).strict(),
    result: ApprovalDecisionSchema,
  },
  'item/permissions/requestApproval': {
    params: ApprovalParamsSchema.extend({
      permission: z.string().min(1),
      scope: z.enum(['session', 'project', 'user']),
    }).strict(),
    result: ApprovalDecisionSchema,
  },
  'item/tool/requestUserInput': {
    params: z
      .object({
        ...ServerRequestBaseShape,
        questions: z
          .array(
            z
              .object({
                id: z.string().min(1),
                header: z.string().min(1),
                question: z.string().min(1),
                multiple: z.boolean(),
                options: z
                  .array(
                    z
                      .object({
                        label: z.string().min(1),
                        description: z.string(),
                      })
                      .strict(),
                  )
                  .min(1)
                  .readonly(),
              })
              .strict(),
          )
          .min(1)
          .readonly(),
      })
      .strict(),
    result: UserInputResolutionSchema,
  },
  'item/plan/requestApproval': {
    params: ApprovalParamsSchema.extend({
      contentHash: z.string().min(1),
      preview: z.string(),
    }).strict(),
    result: ApprovalDecisionSchema,
  },
} as const;

export type ServerRequestMethod = keyof typeof SERVER_REQUEST_SCHEMAS;
export type ServerRequestParams<M extends ServerRequestMethod> = z.output<
  (typeof SERVER_REQUEST_SCHEMAS)[M]['params']
>;
export type ServerRequestResult<M extends ServerRequestMethod> = z.output<
  (typeof SERVER_REQUEST_SCHEMAS)[M]['result']
>;
export type ServerRequest = {
  [M in ServerRequestMethod]: {
    readonly id: string;
    readonly method: M;
    readonly params: ServerRequestParams<M>;
  };
}[ServerRequestMethod];

/**
 * 校验 JSON-RPC 协议的 `server-requests` 模块 的输入并返回已满足领域约束的值。
 *
 * Args:
 * - `method`: `parseServerRequestParams` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `params`: `parseServerRequestParams` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `parseServerRequestParams` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 JSON-RPC 协议的 `server-requests` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function parseServerRequestParams<M extends ServerRequestMethod>(
  method: M,
  params: unknown,
): ServerRequestParams<M> {
  return parseNestedSchemaMap(SERVER_REQUEST_SCHEMAS, method, 'params', params);
}

/**
 * 校验 JSON-RPC 协议的 `server-requests` 模块 的输入并返回已满足领域约束的值。
 *
 * Args:
 * - `method`: `parseServerRequestResult` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `result`: 用于完成唯一待处理操作的结果；同一结果不得重复消费。
 *
 * Returns:
 * - 返回 `parseServerRequestResult` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 JSON-RPC 协议的 `server-requests` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function parseServerRequestResult<M extends ServerRequestMethod>(
  method: M,
  result: unknown,
): ServerRequestResult<M> {
  return parseNestedSchemaMap(SERVER_REQUEST_SCHEMAS, method, 'result', result);
}
