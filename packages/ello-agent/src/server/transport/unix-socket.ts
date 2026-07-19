import type WebSocket from 'ws';

import type { AppServerTransport } from './transport.js';
import { WebSocketTransport } from './websocket.js';

/** Unix endpoint 使用 WebSocket framing；消息边界由 WebSocket 提供，不再复制 JSONL socket 协议。 */
export class UnixSocketTransport implements AppServerTransport {
  readonly kind = 'unix' as const;
  readonly connectionId: string;
  private readonly delegate: WebSocketTransport;

  constructor(socket: WebSocket, connectionId?: string) {
    this.delegate = new WebSocketTransport(
      socket,
      connectionId === undefined ? {} : { connectionId },
    );
    this.connectionId = this.delegate.connectionId;
  }

  messages(): AsyncIterable<Uint8Array> {
    return this.delegate.messages();
  }

  send(message: Uint8Array): Promise<void> {
    return this.delegate.send(message);
  }

  close(reason?: string): Promise<void> {
    return this.delegate.close(reason);
  }
}
