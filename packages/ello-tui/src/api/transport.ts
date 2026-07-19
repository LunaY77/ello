export type ClientTransportKind = 'stdio' | 'websocket' | 'unix' | 'memory';

/**
 * Client 只依赖消息 transport；stdio、WebSocket 与 Unix socket 不得各自解析 RPC。
 */
export interface ClientTransport {
  readonly kind: ClientTransportKind;
  messages(): AsyncIterable<Uint8Array>;
  send(message: Uint8Array): Promise<void>;
  close(reason?: string): Promise<void>;
}
