/**
 * typed RPC route 的协议映射、capability、feature handler 绑定与稳定 offset 分页工具。
 *
 * route 类型全部从 protocol schema 派生；应用 feature 只能在参数解析完成后运行，并且每个 method 的
 * capability 必须由同一张闭合映射决定。
 */
import {
  AppServerError,
  type ClientMethod,
  Capability,
  type ClientResult,
  type ParsedClientParams,
  type PendingServerRequest,
  type ServerNotification,
} from '../../protocol/v1/index.js';

export type RoutableClientMethod = Exclude<ClientMethod, 'initialize'>;
export type ServerClientMethod = 'server/read' | 'server/shutdown';
export type ApplicationClientMethod = Exclude<
  RoutableClientMethod,
  ServerClientMethod
>;

export interface RpcPeer {
  readonly connectionId: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly supportsServerRequests: boolean;
  notify(notification: ServerNotification): Promise<void>;
  request(request: PendingServerRequest): Promise<unknown>;
}

/** RPC peer 的 transport 已关闭，尚未完成的 Server Request 必须交给其他可用连接或等待重放。 */
export class RpcPeerUnavailableError extends Error {
  override readonly name = 'RpcPeerUnavailableError';

  /**
   * 创建只表示连接不可用的控制流错误。
   *
   * Args:
   * - `message`: transport 关闭原因；用于日志和上层错误链，不表示业务请求已经失败。
   */
  constructor(message: string) {
    super(message);
  }
}

export interface RpcRoute<M extends RoutableClientMethod> {
  readonly capability: Capability;
  run(
    peer: RpcPeer,
    params: ParsedClientParams<M>,
  ): ClientResult<M> | Promise<ClientResult<M>>;
}

export type RpcRouteFragment<
  M extends RoutableClientMethod = RoutableClientMethod,
> = {
  readonly [K in M]: RpcRoute<K>;
};

export type RpcRouteTable = RpcRouteFragment<RoutableClientMethod>;
export type RpcApplicationRouteTable =
  RpcRouteFragment<ApplicationClientMethod>;

export const CLIENT_METHOD_CAPABILITIES = {
  initialize: null,
  'server/read': 'read',
  'server/shutdown': 'admin',
  'thread/start': 'write',
  'thread/resume': 'write',
  'thread/read': 'read',
  'thread/list': 'read',
  'thread/loaded/list': 'read',
  'thread/fork': 'write',
  'thread/unsubscribe': 'write',
  'thread/archive': 'write',
  'thread/unarchive': 'write',
  'thread/delete': 'write',
  'thread/turns/list': 'read',
  'thread/items/list': 'read',
  'thread/export': 'read',
  'artifact/read': 'read',
  'thread/compact/start': 'write',
  'thread/shellCommand': 'write',
  'thread/settings/update': 'write',
  'turn/start': 'submit',
  'turn/steer': 'submit',
  'turn/interrupt': 'submit',
  'thread/goal/get': 'read',
  'thread/goal/set': 'write',
  'thread/goal/clear': 'write',
  'thread/plan/read': 'read',
  'thread/plan/preview': 'read',
  'config/read': 'read',
  'config/settings': 'read',
  'config/write': 'write',
  'config/init': 'write',
  'config/sources': 'read',
  'model/list': 'read',
  'provider/list': 'read',
  'agent/list': 'read',
  'tool/list': 'read',
  'skills/list': 'read',
  'skills/get': 'read',
  'skills/reload': 'write',
  'memory/status': 'read',
  'memory/reload': 'write',
  'memory/dream/start': 'write',
  'task/list': 'read',
  'task/get': 'read',
  'task/create': 'write',
  'task/update': 'write',
  'task/delete': 'write',
  'task/claim': 'write',
  'task/reset': 'write',
  'fs/readFile': 'read',
  'fs/readDirectory': 'read',
  'fs/getMetadata': 'read',
  'fs/search': 'read',
  'fs/watch': 'write',
  'fs/unwatch': 'write',
  'repo/add': 'write',
  'repo/list': 'read',
  'repo/read': 'read',
  'repo/rename': 'write',
  'repo/remove': 'write',
  'repo/fetch': 'write',
  'repo/fetchLocal': 'write',
  'repo/remote/read': 'read',
  'repo/remote/add': 'write',
  'repo/remote/set': 'write',
  'repo/remote/remove': 'write',
  'repo/export': 'read',
  'repo/import': 'write',
  'workspace/create': 'write',
  'workspace/list': 'read',
  'workspace/archived/list': 'read',
  'workspace/read': 'read',
  'workspace/path': 'read',
  'workspace/status': 'read',
  'workspace/repo/add': 'write',
  'workspace/repo/create': 'write',
  'workspace/repo/remove': 'write',
  'workspace/rename': 'write',
  'workspace/archive': 'write',
  'workspace/delete': 'write',
  'workspace/reconcile': 'write',
  'workspace/repair': 'write',
  'workspace/tmux/new': 'write',
} as const satisfies Record<ClientMethod, Capability | null>;

/**
 * 执行 Server 门面的 `route` 模块 定义的 `route` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `capability`: `route` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `run`: `route` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `route` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function route<M extends RoutableClientMethod>(
  capability: Capability,
  run: RpcRoute<M>['run'],
): RpcRoute<M> {
  return { capability, run };
}

/**
 * 执行 Server 门面的 `route` 模块 定义的 `capabilityFor` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `method`: `capabilityFor` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `capabilityFor` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function capabilityFor(method: RoutableClientMethod): Capability {
  const capability = CLIENT_METHOD_CAPABILITIES[method];
  if (capability === null) {
    throw new Error(`Method ${method} is not routable.`);
  }
  return capability;
}

/**
 * 执行 Server 门面的 `route` 模块 定义的 `isClientMethod` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `method`: `isClientMethod` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `isClientMethod` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function isClientMethod(method: string): method is ClientMethod {
  return method in CLIENT_METHOD_CAPABILITIES;
}

/**
 * 执行 Server 门面的 `route` 模块 定义的 `isRoutableClientMethod` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `method`: `isRoutableClientMethod` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `isRoutableClientMethod` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function isRoutableClientMethod(
  method: string,
): method is RoutableClientMethod {
  return method !== 'initialize' && isClientMethod(method);
}

/**
 * 执行 Server 门面的 `route` 模块 定义的 `FeatureHandler` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `context`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
 * - `params`: `FeatureHandler` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `FeatureHandler` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export type FeatureHandler<TContext, TMethod extends RoutableClientMethod> = (
  context: TContext,
  params: ParsedClientParams<TMethod>,
) => ClientResult<TMethod> | Promise<ClientResult<TMethod>>;

export type FeatureHandlerMap<
  TContext,
  TMethod extends RoutableClientMethod,
> = {
  readonly [K in TMethod]: FeatureHandler<TContext, K>;
};

/**
 * 把 feature handler 绑定为带 capability 的 typed route。
 *
 * Args:
 * - `handlers`: 覆盖闭合 method 集合的 handler map。
 * - `createContext`: 根据当前连接创建该 feature 所需最小上下文的函数。
 * - `method`: 本次绑定的具体协议 method。
 *
 * Returns:
 * - 返回 capability 与参数/结果类型都由 method 唯一确定的 route。
 */
export function bindFeatureRoute<
  TContext,
  TMethods extends RoutableClientMethod,
  TMethod extends TMethods,
>(
  handlers: FeatureHandlerMap<TContext, TMethods>,
  createContext: (peer: RpcPeer) => TContext,
  method: TMethod,
): RpcRoute<TMethod> {
  return route<TMethod>(capabilityFor(method), (peer, params) =>
    handlers[method](createContext(peer), params),
  );
}

export interface Page<TItem> {
  readonly data: ReadonlyArray<TItem>;
  readonly nextCursor?: string;
}

/**
 * 解析只表示稳定列表偏移的 cursor。
 *
 * Args:
 * - `cursor`: 协议输入中的十进制安全整数；缺失表示从首项开始。
 *
 * Returns:
 * - 返回非负数组偏移。
 *
 * Throws:
 * - 当 cursor 不是非负安全整数时抛出 `invalidParams`。
 */
export function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AppServerError({
      type: 'invalidParams',
      message: `Invalid pagination cursor ${cursor}.`,
    });
  }
  return offset;
}

/**
 * 对内存稳定序列应用 offset cursor 分页。
 *
 * Args:
 * - `values`: 当前读取快照内顺序稳定的完整值序列。
 * - `cursor`: 起始 offset 的协议字符串。
 * - `limit`: 本页最多返回的条目数，已由协议 schema 校验为正整数。
 *
 * Returns:
 * - 返回当前页数据；仍有后续条目时携带下一 offset cursor。
 */
export function page<TItem>(
  values: ReadonlyArray<TItem>,
  cursor: string | undefined,
  limit: number,
): Page<TItem> {
  const offset = parseCursor(cursor);
  const data = values.slice(offset, offset + limit);
  const nextOffset = offset + data.length;
  return {
    data,
    ...(nextOffset < values.length ? { nextCursor: String(nextOffset) } : {}),
  };
}
