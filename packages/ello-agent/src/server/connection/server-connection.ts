import type {
  Capability,
  RpcRequestId,
  ServerNotification,
  ServerRequestMethod,
  ServerRequestParams,
  ServerRequestResult,
} from '../../protocol/v1/index.js';
import type { AppServerTransport } from '../transport/transport.js';

import { ConnectionState } from './connection-state.js';
import { PendingServerRequests } from './pending-server-requests.js';

export interface ConnectionProcessor {
  process(connection: ServerConnection, message: Uint8Array): Promise<void>;
}

export class ServerConnection {
  readonly id: string;
  readonly state: ConnectionState;
  readonly serverRequests: PendingServerRequests;
  private readonly encoder = new TextEncoder();
  private sendQueue: Promise<void> = Promise.resolve();
  private heldMessages: Readonly<Record<string, unknown>>[] | undefined;
  private queuedSends = 0;
  private closed = false;
  private readonly maxQueuedSends: number;

  constructor(
    private readonly transport: AppServerTransport,
    capabilities: readonly Capability[],
    options: { readonly maxQueuedSends?: number } = {},
  ) {
    this.id = transport.connectionId;
    this.state = new ConnectionState(capabilities);
    this.maxQueuedSends = options.maxQueuedSends ?? 256;
    this.serverRequests = new PendingServerRequests((message) =>
      this.sendUnsolicited(message),
    );
  }

  get kind(): AppServerTransport['kind'] {
    return this.transport.kind;
  }

  async run(processor: ConnectionProcessor): Promise<void> {
    try {
      for await (const message of this.transport.messages()) {
        await processor.process(this, message);
      }
    } finally {
      await this.close('transport ended');
    }
  }

  sendResult(id: RpcRequestId, result: unknown): Promise<void> {
    return this.send({ jsonrpc: '2.0', id, result });
  }

  sendError(
    id: RpcRequestId | null,
    error: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return this.send({ jsonrpc: '2.0', id, error });
  }

  sendNotification(notification: ServerNotification): Promise<void> {
    return this.sendUnsolicited({ jsonrpc: '2.0', ...notification });
  }

  request<M extends ServerRequestMethod>(
    id: string,
    method: M,
    params: ServerRequestParams<M>,
  ): Promise<ServerRequestResult<M>> {
    return this.serverRequests.request(id, method, params);
  }

  /**
   * RPC response 落到 wire 前暂存该连接的 notification/Server Request。
   * 这样 thread/resume 的 snapshot 一定先于 pending request 和 live event 到达 Client。
   */
  holdUnsolicited(): () => Promise<void> {
    if (this.heldMessages !== undefined) {
      throw new Error(
        `Connection ${this.id} already has an outbound response barrier.`,
      );
    }
    this.heldMessages = [];
    return async () => {
      const messages = this.heldMessages;
      this.heldMessages = undefined;
      if (messages === undefined) return;
      for (const message of messages) await this.send(message);
    };
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.state.close();
    this.serverRequests.disconnect(new Error(`Connection closed: ${reason}`));
    await this.sendQueue;
    await this.transport.close(reason);
  }

  private send(message: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Connection is closed.'));
    if (this.queuedSends >= this.maxQueuedSends) {
      const error = new Error(
        `Connection outbound queue exceeds ${this.maxQueuedSends} messages.`,
      );
      void this.closeOverloaded(error);
      return Promise.reject(error);
    }
    this.queuedSends += 1;
    const operation = this.sendQueue.then(() =>
      this.transport.send(this.encoder.encode(JSON.stringify(message))),
    );
    this.sendQueue = operation.then(
      () => {
        this.queuedSends -= 1;
      },
      () => {
        this.queuedSends -= 1;
      },
    );
    return operation;
  }

  private sendUnsolicited(
    message: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Connection is closed.'));
    if (this.heldMessages !== undefined) {
      this.heldMessages = [...this.heldMessages, message];
      return Promise.resolve();
    }
    return this.send(message);
  }

  private async closeOverloaded(error: Error): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.state.close();
    this.serverRequests.disconnect(error);
    this.heldMessages = undefined;
    await this.transport.close(error.message).catch(() => undefined);
  }
}
