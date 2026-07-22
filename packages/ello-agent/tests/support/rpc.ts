/**
 * 本文件验证 rpc 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import {
  parseClientParams,
  type Capability,
  type ClientParams,
  type ClientResult,
} from '../../src/protocol/v1/index.js';
import type {
  RoutableClientMethod,
  RpcPeer,
  RpcRouteFragment,
} from '../../src/server/rpc/route.js';

const ALL_CAPABILITIES = [
  'read',
  'submit',
  'approve',
  'write',
  'admin',
] as const satisfies ReadonlyArray<Capability>;

/**
 * 构造 测试夹具的 `rpc` 模块 中的 `createTestPeer` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `input`: `createTestPeer` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败；省略时使用声明中明确的调用语义。
 *
 * Returns:
 * - 返回 `createTestPeer` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 测试夹具的 `rpc` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createTestPeer(
  input: {
    readonly connectionId?: string;
    readonly capabilities?: ReadonlyArray<Capability>;
    readonly supportsServerRequests?: boolean;
    readonly notify?: RpcPeer['notify'];
    readonly request?: RpcPeer['request'];
  } = {},
): RpcPeer {
  return {
    connectionId: input.connectionId ?? 'connection_test',
    capabilities: new Set(input.capabilities ?? ALL_CAPABILITIES),
    supportsServerRequests: input.supportsServerRequests ?? false,
    notify: input.notify ?? (() => Promise.resolve()),
    request:
      input.request ??
      (() => Promise.reject(new Error('Unexpected Server Request.'))),
  };
}

/**
 * 执行 测试夹具的 `rpc` 模块 定义的 `invokeServiceRoute` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `services`: `invokeServiceRoute` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `peer`: `invokeServiceRoute` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `method`: `invokeServiceRoute` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `params`: `invokeServiceRoute` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - Promise 在 测试夹具的 `rpc` 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
export async function invokeServiceRoute<M extends RoutableClientMethod>(
  services: { readonly routes: RpcRouteFragment<M> },
  peer: RpcPeer,
  method: M,
  params: ClientParams<M>,
): Promise<ClientResult<M>> {
  return services.routes[method].run(peer, parseClientParams(method, params));
}
