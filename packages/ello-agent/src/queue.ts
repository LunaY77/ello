/** 消息队列取出模式。 */
export type MessageQueueMode = 'all' | 'one-at-a-time';

/**
 * 消息队列, 支持在 agent 运行过程中注入 steering/follow-up 消息。
 *
 * Args:
 *   mode: "all" 表示一次性 drain 全部, "one-at-a-time" 表示每次只取一条。
 */
export class MessageQueue {
  private readonly messages: string[] = [];
  readonly mode: MessageQueueMode;

  constructor(mode: MessageQueueMode = 'one-at-a-time') {
    this.mode = mode;
  }

  /**
   * 添加消息到队列尾部。
   *
   * Args:
   *   message: 要追加的消息内容。
   */
  enqueue(message: string): void {
    this.messages.push(message);
  }

  /**
   * 取出消息。
   *
   * Returns:
   *   根据 mode 返回全部消息或队首单条消息; 队列为空时返回空数组。
   */
  drain(): string[] {
    if (this.messages.length === 0) {
      return [];
    }
    if (this.mode === 'all') {
      const drained = [...this.messages];
      this.messages.length = 0;
      return drained;
    }
    const next = this.messages.shift();
    return next === undefined ? [] : [next];
  }

  /** 是否有待处理消息。 */
  get hasItems(): boolean {
    return this.messages.length > 0;
  }

  /** Python 兼容命名: 是否有待处理消息。 */
  get has_items(): boolean {
    return this.hasItems;
  }

  /** 清空队列中全部待处理消息。 */
  clear(): void {
    this.messages.length = 0;
  }
}
