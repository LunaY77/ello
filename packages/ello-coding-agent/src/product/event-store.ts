import { EventEmitter } from 'node:events';

import type { CodingAgentEvent, SessionInfo, ToolCallView } from './events.js';

/** 从事件折叠出的产品层快照。 */
export interface ProductSnapshot {
  readonly session?: SessionInfo;
  readonly events: CodingAgentEvent[];
  readonly transcript: TranscriptItem[];
  readonly runningTools: ToolCallView[];
  readonly completedTools: ToolCallView[];
  readonly approvals: CodingAgentEvent[];
  readonly currentAssistantText: string;
  readonly running: boolean;
}

/** TUI transcript 的稳定 item。 */
export type TranscriptItem =
  | { readonly id: string; readonly role: 'user' | 'assistant' | 'diagnostic'; readonly text: string }
  | { readonly id: string; readonly role: 'tool'; readonly tool: ToolCallView };

/**
 * 产品事件存储。
 *
 * 它是 CLI/TUI/RPC 共享的 domain source of truth：runtime 只 append 事件，
 * renderer 通过 snapshot/selectors 消费，不回头读取 JSONL 文件或 core event。
 */
export class ProductEventStore {
  private readonly emitter = new EventEmitter();
  private readonly events: CodingAgentEvent[] = [];
  private pendingDelta: Extract<CodingAgentEvent, { type: 'message.delta' }> | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 追加一个产品事件并通知订阅者。
   *
   * message.delta 会在 40ms 窗口内合并，避免 token 级事件让 Ink 整棵 App
   * 高频重渲染；任何非 delta 事件都会先 flush，保证最终事件顺序稳定。
   */
  append(event: CodingAgentEvent): void {
    if (event.type === 'message.delta') {
      this.appendDelta(event);
      return;
    }
    this.flushDelta();
    this.events.push(event);
    this.emitter.emit('event', event);
  }

  /** 订阅后续事件，返回取消订阅函数。 */
  subscribe(listener: (event: CodingAgentEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  /** 返回当前所有事件的浅拷贝。 */
  all(): CodingAgentEvent[] {
    this.flushDelta();
    return [...this.events];
  }

  /** 从事件折叠出 UI 需要的只读快照。 */
  snapshot(): ProductSnapshot {
    this.flushDelta();
    const transcript: TranscriptItem[] = [];
    const tools = new Map<string, ToolCallView>();
    const approvals: CodingAgentEvent[] = [];
    let currentAssistantText = '';
    let currentMessageId = '';
    let session: SessionInfo | undefined;
    let running = false;
    const transcriptToolIds = new Set<string>();
    for (const event of this.events) {
      if (event.type === 'session.started') {
        session = event.session;
      } else if (event.type === 'run.started') {
        running = true;
        transcript.push({ id: `${event.runId}:user`, role: 'user', text: event.input.prompt });
        currentAssistantText = '';
        currentMessageId = '';
      } else if (event.type === 'message.delta') {
        if (currentMessageId !== event.messageId) {
          if (currentAssistantText.trim()) {
            transcript.push({ id: currentMessageId, role: 'assistant', text: currentAssistantText });
          }
          currentAssistantText = '';
          currentMessageId = event.messageId;
        }
        currentAssistantText += event.text;
      } else if (event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'tool.completed') {
        tools.set(event.call.id, event.call);
        if (event.type === 'tool.completed' && !transcriptToolIds.has(event.call.id)) {
          transcript.push({ id: event.call.id, role: 'tool', tool: event.call });
          transcriptToolIds.add(event.call.id);
        }
      } else if (event.type === 'approval.requested') {
        approvals.push(event);
      } else if (event.type === 'runtime.diagnostic') {
        transcript.push({ id: `${event.createdAt}:${event.message}`, role: 'diagnostic', text: event.message });
      } else if (event.type === 'run.completed' || event.type === 'run.failed') {
        running = false;
        if (currentAssistantText.trim()) {
          transcript.push({ id: currentMessageId || event.createdAt, role: 'assistant', text: currentAssistantText });
          currentAssistantText = '';
        }
      }
    }
    const runningTools = [...tools.values()].filter((tool) => tool.status === 'pending' || tool.status === 'running');
    const completedTools = [...tools.values()].filter((tool) => tool.status !== 'pending' && tool.status !== 'running');
    return {
      ...(session !== undefined ? { session } : {}),
      events: [...this.events],
      transcript,
      runningTools,
      completedTools,
      approvals,
      currentAssistantText,
      running,
    };
  }

  private appendDelta(event: Extract<CodingAgentEvent, { type: 'message.delta' }>): void {
    if (
      this.pendingDelta !== null &&
      this.pendingDelta.sessionId === event.sessionId &&
      this.pendingDelta.runId === event.runId &&
      this.pendingDelta.messageId === event.messageId
    ) {
      this.pendingDelta = {
        ...event,
        text: this.pendingDelta.text + event.text,
      };
    } else {
      this.flushDelta();
      this.pendingDelta = event;
    }
    if (this.pendingTimer === null) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.flushDelta();
      }, 40);
    }
  }

  private flushDelta(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.pendingDelta === null) {
      return;
    }
    const event = this.pendingDelta;
    this.pendingDelta = null;
    this.events.push(event);
    this.emitter.emit('event', event);
  }
}
