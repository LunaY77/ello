import type { ServerNotification } from './protocol-types.js';

export type NotificationListener = (notification: ServerNotification) => void;

export class NotificationSubscription {
  private readonly listeners = new Set<NotificationListener>();

  add(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(notification: ServerNotification): void {
    for (const listener of this.listeners) listener(notification);
  }

  clear(): void { this.listeners.clear(); }
}
