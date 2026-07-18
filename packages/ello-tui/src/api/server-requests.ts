import type { IncomingServerRequest } from './client.js';
import type { ServerRequestMethod } from './protocol-types.js';

export type ClientServerRequest = {
  [M in ServerRequestMethod]: IncomingServerRequest<M>;
}[ServerRequestMethod];

export type ApprovalServerRequest = Exclude<
  ClientServerRequest,
  { readonly method: 'item/tool/requestUserInput' }
>;

export function isApprovalRequest(request: ClientServerRequest): request is ApprovalServerRequest {
  return request.method.endsWith('requestApproval');
}

export function isUserInputRequest(request: ClientServerRequest): boolean {
  return request.method === 'item/tool/requestUserInput';
}
