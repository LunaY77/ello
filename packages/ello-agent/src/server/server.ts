/**
 * 本文件负责 App Server 的“server”模块职责。
 *
 * 连接、请求或传输状态只由本模块返回的对象持有；Server 不依赖产品 feature 的内部实现。
 * 响应、通知、背压和关闭顺序是协议不变量，异步失败必须传播到拥有该资源的生命周期边界。
 */
import type { Writable } from 'node:stream';

import type { Capability } from '../protocol/v1/index.js';

import {
  route,
  type RpcApplicationRouteTable,
  type RpcRouteTable,
} from './rpc/route.js';
import { ServerConnection } from './server-connection.js';
import type { AppServerTransport } from './transport/transport.js';

export type AgentServerState = 'starting' | 'ready' | 'stopping' | 'stopped';

export interface AgentServerOptions {
  readonly version: string;
  readonly transports: readonly ('stdio' | 'websocket' | 'unix')[];
  readonly routes: RpcApplicationRouteTable;
  /**
   * 初始化 Server 门面的 `server` 模块 所需的目录、连接或缓存；完成前不得使用依赖这些资源的操作。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在依赖资源全部可用后兑现；兑现前实例仍视为未就绪。
   *
   * Throws:
   * - 当 Server 门面的 `server` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  readonly initialize: () => Promise<void>;
  readonly releaseConnection: (connectionId: string) => Promise<void>;
  readonly closeResources: () => Promise<void>;
  readonly stderr?: Writable;
}

/** Server 进程的唯一生命周期所有者。 */
export class AgentServer {
  readonly protocolVersion = 1;
  private currentState: AgentServerState = 'starting';
  private readonly connections = new Map<string, ServerConnection>();
  private readonly routes: RpcRouteTable;
  private readonly stderr: Writable;
  private readonly startedAt = Date.now();
  private readonly stoppedPromise: Promise<void>;
  private resolveStopped: () => void = () => undefined;

  /**
   * 创建 `AgentServer`，由该实例独占 Server 门面的 `server` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `options`: 仅作用于 `constructor AgentServer` 的调用选项；函数只读取该对象，不保留可变引用。
   */
  constructor(private readonly options: AgentServerOptions) {
    this.stderr = options.stderr ?? process.stderr;
    this.stoppedPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
    this.routes = {
      'server/read': route('read', (peer) => ({
        protocolVersion: 1,
        version: this.options.version,
        state: this.currentState,
        uptimeMs: Date.now() - this.startedAt,
        capabilities: [...peer.capabilities],
      })),
      'server/shutdown': route('admin', (_peer, params) => {
        setImmediate(() => void this.stop(params.reason ?? 'client request'));
        return { ok: true };
      }),
      ...options.routes,
    } satisfies RpcRouteTable;
  }

  /**
   * 读取 Server 门面的 `server` 模块 持有的 `state` 快照，不改变底层状态。
   *
   * Returns:
   * - 返回 Server 门面的 `server` 模块 当前持有的只读视图，不触发状态转换。
   */
  get state(): AgentServerState {
    return this.currentState;
  }

  /**
   * 在 Server 门面的 `server` 模块 中执行 `start` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Server 门面的 `server` 模块 的异步副作用完整提交后兑现，不返回业务值。
   *
   * Throws:
   * - 当 Server 门面的 `server` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async start(): Promise<void> {
    if (this.currentState !== 'starting') {
      throw new Error(`Cannot start AgentServer from ${this.currentState}.`);
    }
    await this.options.initialize();
    this.currentState = 'ready';
  }

  /**
   * 执行 Server 门面的 `server` 模块 定义的 `acceptTransport` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `transport`: `acceptTransport` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `capabilities`: `acceptTransport` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Server 门面的 `server` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async acceptTransport(
    transport: AppServerTransport,
    capabilities: readonly Capability[],
  ): Promise<void> {
    if (this.currentState !== 'ready') {
      throw new Error(
        `Cannot accept transport while Server is ${this.currentState}.`,
      );
    }
    if (this.connections.has(transport.connectionId)) {
      throw new Error(`Duplicate connection ${transport.connectionId}.`);
    }
    const connection = new ServerConnection(transport, capabilities, {
      routes: this.routes,
      version: this.options.version,
      transports: this.options.transports,
      log: (event, details) =>
        this.log(event, { connectionId: transport.connectionId, ...details }),
    });
    this.connections.set(connection.id, connection);
    try {
      await connection.run();
    } catch (error) {
      this.log('connection.failed', {
        connectionId: connection.id,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await this.options.releaseConnection(connection.id);
      this.connections.delete(connection.id);
    }
  }

  /**
   * 执行 Server 门面的 `server` 模块 定义的 `stop` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `reason`: 可观察的终止或拒绝原因；会随失败状态向上游传播。
   *
   * Returns:
   * - Promise 在 Server 门面的 `server` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async stop(reason: string): Promise<void> {
    if (this.currentState === 'stopped') return;
    if (this.currentState === 'stopping') return this.stoppedPromise;
    this.currentState = 'stopping';
    this.log('server.stopping', { reason });
    const failures: unknown[] = [];
    await Promise.all(
      [...this.connections.values()].map(async (connection) => {
        try {
          await connection.close(reason);
        } catch (error) {
          failures.push(error);
        }
      }),
    );
    try {
      await this.options.closeResources();
    } catch (error) {
      failures.push(error);
    }
    this.currentState = 'stopped';
    this.resolveStopped();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'AgentServer shutdown failed.');
    }
  }

  /**
   * 执行 Server 门面的 `server` 模块 定义的 `waitUntilStopped` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Server 门面的 `server` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  waitUntilStopped(): Promise<void> {
    return this.stoppedPromise;
  }

  /**
   * 记录 listener 或已建立连接的结构化失败，不改变 Server 生命周期。
   *
   * Args:
   * - `event`: 稳定的日志事件名称。
   * - `error`: listener 捕获的原始失败；message 会写入 Server 的 stderr。
   *
   * Returns:
   * - 日志写入调用完成后返回。
   */
  logConnectionFailure(event: string, error: unknown): void {
    this.log(event, {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private log(event: string, details: Readonly<Record<string, unknown>>): void {
    this.stderr.write(
      `${JSON.stringify({
        level: 'info',
        event,
        at: new Date().toISOString(),
        ...details,
      })}\n`,
    );
  }
}
