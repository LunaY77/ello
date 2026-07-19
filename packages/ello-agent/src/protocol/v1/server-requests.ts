import { z } from 'zod';

import {
  ApprovalDecisionSchema,
  OpaqueIdSchema,
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

export function parseServerRequestParams<M extends ServerRequestMethod>(
  method: M,
  params: unknown,
): ServerRequestParams<M> {
  return SERVER_REQUEST_SCHEMAS[method].params.parse(
    params,
  ) as ServerRequestParams<M>;
}

export function parseServerRequestResult<M extends ServerRequestMethod>(
  method: M,
  result: unknown,
): ServerRequestResult<M> {
  return SERVER_REQUEST_SCHEMAS[method].result.parse(
    result,
  ) as ServerRequestResult<M>;
}
