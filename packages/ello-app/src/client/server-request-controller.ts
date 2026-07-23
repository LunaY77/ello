/**
 * Server Request 生命周期控制器:live 到达的 srvreq 登记进 interaction 队列,
 * 应答统一走持久化 srvreq_* ID。Controller 不持有 resolvable 闭包 ——
 * 重连后从快照重建的审批与 live 审批走完全相同的应答路径。
 */
import type {
  ServerRequestMethod,
  ServerRequestResult,
} from '@ello/agent/protocol';


import type { AppServerClient, IncomingServerRequest } from './app-server-client.js';
import type { StoreEvent } from './event-reducer.js';

import type { AppState } from '@/store/types';

export class ServerRequestController {
  constructor(
    private readonly client: AppServerClient,
    private readonly getState: () => AppState,
    private readonly dispatch: (event: StoreEvent) => void,
  ) {}

  /** 订阅 client 的 server request 流;返回解除函数。 */
  attach(): () => void {
    return this.client.onServerRequest((request) => {
      this.register(request);
      return true;
    });
  }

  /** 应答一条待处理请求;entry 不存在说明状态已被事件流收敛,直接抛错。 */
  async respond<M extends ServerRequestMethod>(
    requestId: string,
    result: ServerRequestResult<M>,
  ): Promise<void> {
    const entry = this.getState().interaction.pendingRequests.find(
      (candidate) => candidate.id === requestId,
    );
    if (entry === undefined) {
      throw new Error(`Server request ${requestId} is no longer pending.`);
    }
    this.dispatch({
      kind: 'server-request-state',
      requestId,
      state: 'responding',
    });
    await this.client.respondToServerRequest(
      entry.id,
      entry.method as M,
      result,
    );
  }

  private register(
    request: IncomingServerRequest<ServerRequestMethod>,
  ): void {
    this.dispatch({
      kind: 'server-request-received',
      entry: {
        id: request.id,
        method: request.method,
        threadId: request.params.threadId,
        turnId: request.params.turnId,
        itemId: request.params.itemId,
        params: request.params,
        createdAt: new Date().toISOString(),
        state: 'pending',
      },
    });
  }
}
