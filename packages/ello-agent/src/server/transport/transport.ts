export type AppServerTransportKind = 'stdio' | 'websocket' | 'unix';

/** transport 只搬运完整消息字节，不解析 method 或业务参数。 */
export interface AppServerTransport {
  readonly kind: AppServerTransportKind;
  readonly connectionId: string;
  messages(): AsyncIterable<Uint8Array>;
  send(message: Uint8Array): Promise<void>;
  close(reason?: string): Promise<void>;
}
