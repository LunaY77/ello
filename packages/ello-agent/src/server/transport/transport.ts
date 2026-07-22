/**
 * 本文件负责 App Server 的“transport”模块职责。
 *
 * 连接、请求或传输状态只由本模块返回的对象持有；Server 不依赖产品 feature 的内部实现。
 * 响应、通知、背压和关闭顺序是协议不变量，异步失败必须传播到拥有该资源的生命周期边界。
 */
export type AppServerTransportKind = 'stdio' | 'websocket' | 'unix';

/** transport 只搬运完整消息字节，不解析 method 或业务参数。 */
export interface AppServerTransport {
  readonly kind: AppServerTransportKind;
  readonly connectionId: string;
  messages(): AsyncIterable<Uint8Array>;
  send(message: Uint8Array): Promise<void>;
  /**
   * 停止 Server 门面的 `transport` 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
   *
   * Args:
   * - `reason`: 可观察的终止或拒绝原因；会随失败状态向上游传播；省略时使用声明中明确的调用语义。
   * - `force`: 显式控制 `close` 分支的布尔值；只影响当前调用。
   *
   * Returns:
   * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
   *
   * Throws:
   * - 当 Server 门面的 `transport` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  close(reason?: string, force?: boolean): Promise<void>;
}
