import type {
  PendingServerRequest,
  ServerNotification,
} from '../../protocol/v1/index.js';

export type SubscriptionListener = (
  notification: ServerNotification,
) => void | Promise<void>;

export type ServerRequestListener = (
  request: PendingServerRequest,
) => Promise<unknown>;

interface Subscription {
  readonly notify: SubscriptionListener;
  readonly request?: ServerRequestListener;
}

/** 慢连接由 transport 自己隔离；这里不让一个 listener 阻塞其他连接。 */
export class SubscriptionHub {
  private readonly listeners = new Map<string, Subscription>();

  subscribe(
    connectionId: string,
    listener: SubscriptionListener,
    requestListener?: ServerRequestListener,
  ): () => void {
    if (this.listeners.has(connectionId)) {
      throw new Error(`Connection ${connectionId} is already subscribed.`);
    }
    this.listeners.set(connectionId, {
      notify: listener,
      ...(requestListener === undefined ? {} : { request: requestListener }),
    });
    return () => this.listeners.delete(connectionId);
  }

  has(connectionId: string): boolean {
    return this.listeners.has(connectionId);
  }

  get size(): number {
    return this.listeners.size;
  }

  publish(notification: ServerNotification): void {
    for (const listener of this.listeners.values()) {
      void Promise.resolve(listener.notify(notification)).catch(
        () => undefined,
      );
    }
  }

  /**
   * 同一时刻只把交互交给一个 controller。当前 controller 断线或处理失败时，
   * 按订阅顺序尝试下一个；全部失败仍保留持久化 pending 状态。
   */
  request(request: PendingServerRequest): Promise<unknown> | undefined {
    if (![...this.listeners.values()].some((listener) => listener.request)) {
      return undefined;
    }
    return this.requestWithFailover(request);
  }

  clear(): void {
    this.listeners.clear();
  }

  private async requestWithFailover(
    request: PendingServerRequest,
  ): Promise<unknown> {
    const attempted = new Set<Subscription>();
    let lastError: unknown;
    while (true) {
      const subscription = [...this.listeners.values()].find(
        (candidate) =>
          candidate.request !== undefined && !attempted.has(candidate),
      );
      if (subscription === undefined) {
        throw (
          lastError ?? new Error('No Server Request controller is available.')
        );
      }
      attempted.add(subscription);
      try {
        return await subscription.request!(request);
      } catch (error) {
        lastError = error;
      }
    }
  }
}
