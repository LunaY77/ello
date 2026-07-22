/**
 * 本文件负责把已经通过 JSON-RPC 连接层的 method 调度到 typed route。
 *
 * 通用 Request/Response 关联、Cancellation 和连接事件由 `vscode-jsonrpc` 负责；本模块只执行 Ello
 * 产品协议需要的 capability、Zod 参数校验和返回值校验，不持有连接或传输状态。
 */
import { ZodError } from 'zod';

import {
  AppServerError,
  parseClientParams,
  parseClientResult,
  type ClientResult,
  type ParsedClientParams,
} from '../../protocol/v1/index.js';

import type {
  RoutableClientMethod,
  RpcPeer,
  RpcRouteFragment,
  RpcRouteTable,
} from './route.js';

/**
 * 校验 capability、解析参数并执行唯一匹配的 typed route。
 *
 * Args:
 * - `routes`: 覆盖调用 method 的 route 表；method 与 handler 类型由同一协议映射约束。
 * - `peer`: 当前连接公开给 feature 的最小能力集合。
 * - `method`: 已确认属于 Ello 可路由 Client method 的名称。
 * - `params`: 从 JSON-RPC 边界进入的未知参数对象。
 *
 * Returns:
 * - Promise 在 handler 完成且返回值通过对应 Zod schema 后兑现。
 *
 * Throws:
 * - capability 缺失、参数非法、handler 失败或结果违反协议 schema 时抛出稳定 `AppServerError`。
 */
export async function dispatchRoute<M extends RoutableClientMethod>(
  routes: RpcRouteFragment<M>,
  peer: RpcPeer,
  method: M,
  params: unknown,
): Promise<ClientResult<M>> {
  const selectedRoute = routes[method];
  assertRouteCapability(peer, method, selectedRoute.capability);
  const result = await selectedRoute.run(
    peer,
    parseRouteParams(method, params),
  );
  return parseRouteResult(method, result);
}

/**
 * 确认当前连接拥有 method 声明的 capability。
 *
 * Args:
 * - `peer`: 当前连接协商后的 capability 集合。
 * - `method`: 即将执行的 Client method。
 * - `capability`: route 表为该 method 声明的唯一 capability。
 *
 * Returns:
 * - capability 存在时返回，不产生额外状态。
 *
 * Throws:
 * - capability 缺失时抛出 `permissionDenied`。
 */
export function assertRouteCapability(
  peer: RpcPeer,
  method: RoutableClientMethod,
  capability: RpcRouteTable[RoutableClientMethod]['capability'],
): void {
  if (peer.capabilities.has(capability)) return;
  throw new AppServerError({
    type: 'permissionDenied',
    message: `Method ${method} requires ${capability} capability.`,
    details: { method, capability },
  });
}

function parseRouteParams<TMethod extends RoutableClientMethod>(
  method: TMethod,
  params: unknown,
): ParsedClientParams<TMethod> {
  try {
    return parseClientParams(method, params);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    throw new AppServerError({
      type: 'invalidParams',
      message: 'Request params do not match the protocol schema.',
      details: { method, issues: error.issues },
      cause: error,
    });
  }
}

function parseRouteResult<TMethod extends RoutableClientMethod>(
  method: TMethod,
  result: unknown,
): ClientResult<TMethod> {
  try {
    return parseClientResult(method, result);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    throw new AppServerError({
      type: 'responseValidationFailed',
      message: `Server result for ${method} does not match the protocol schema.`,
      details: { method, issues: error.issues },
      cause: error,
    });
  }
}
