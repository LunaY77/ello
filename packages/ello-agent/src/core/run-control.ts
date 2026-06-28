import type {
  AgentMessage,
  AgentMessageQueue,
  AgentMessageQueueMode,
  AgentRunControlStatus,
  DeferredRunItem,
  DeferredRunResults,
  QueueDrainDiagnostic,
} from '../public/types.js';

export interface AgentRunControlSnapshot {
  readonly status: AgentRunControlStatus;
  readonly interrupted: boolean;
  readonly input: AgentMessage[];
  readonly session: AgentMessage[];
  readonly followUp: AgentMessage[];
  readonly steering: AgentMessage[];
  readonly deferred: DeferredRunItem[];
  readonly sessionDrained: boolean;
}

export class DefaultAgentMessageQueue<
  T = AgentMessage,
> implements AgentMessageQueue<T> {
  private readonly items: T[] = [];

  constructor(readonly mode: AgentMessageQueueMode = 'all') {}

  get size(): number {
    return this.items.length;
  }

  get hasItems(): boolean {
    return this.items.length > 0;
  }

  push(item: T): void {
    this.items.push(item);
  }

  drain(): T[] {
    if (this.items.length === 0) {
      return [];
    }
    if (this.mode === 'one-at-a-time') {
      const item = this.items.shift();
      return item === undefined ? [] : [item];
    }
    return this.items.splice(0);
  }

  clear(): void {
    this.items.splice(0);
  }

  snapshot(): T[] {
    return [...this.items];
  }

  restore(items: readonly T[]): void {
    this.items.splice(0, this.items.length, ...items);
  }
}

export interface DrainNextTurnResult {
  readonly messages: AgentMessage[];
  readonly diagnostics: QueueDrainDiagnostic[];
}

export class AgentRunControl {
  readonly inputQueue = new DefaultAgentMessageQueue<AgentMessage>('all');
  readonly sessionQueue = new DefaultAgentMessageQueue<AgentMessage>('all');
  readonly followUpQueue = new DefaultAgentMessageQueue<AgentMessage>(
    'one-at-a-time',
  );
  readonly steeringQueue = new DefaultAgentMessageQueue<AgentMessage>(
    'one-at-a-time',
  );
  readonly deferredQueue = new DefaultAgentMessageQueue<DeferredRunItem>('all');
  status: AgentRunControlStatus = 'running';
  interrupted = false;
  private sessionDrained = false;

  constructor(readonly runId: string) {}

  pushInput(message: AgentMessage): void {
    this.inputQueue.push(message);
  }

  pushFollowUp(message: AgentMessage): void {
    this.followUpQueue.push(message);
  }

  pushSteering(message: AgentMessage): void {
    this.steeringQueue.push(message);
  }

  pushDeferred(item: DeferredRunItem): void {
    this.deferredQueue.push(item);
    if (item.kind === 'approval') {
      this.status = 'waiting_approval';
    }
    if (item.kind === 'interrupted') {
      this.status = 'interrupted';
      this.interrupted = true;
    }
  }

  hasQueuedWork(): boolean {
    return (
      this.inputQueue.hasItems ||
      this.followUpQueue.hasItems ||
      this.steeringQueue.hasItems ||
      (!this.sessionDrained && this.sessionQueue.hasItems)
    );
  }

  drainNextTurn(resume?: DeferredRunResults): DrainNextTurnResult {
    const diagnostics: QueueDrainDiagnostic[] = [];
    const messages: AgentMessage[] = [];

    const recovery = this.createRecoveryMessages(resume);
    messages.push(...recovery);
    diagnostics.push({ queue: 'deferred', count: recovery.length });

    if (!this.sessionDrained) {
      const drained = this.sessionQueue.drain();
      this.sessionDrained = true;
      messages.push(...drained);
      diagnostics.push({ queue: 'session', count: drained.length });
    } else {
      diagnostics.push({ queue: 'session', count: 0 });
    }

    for (const [queue, drained] of [
      ['input', this.inputQueue.drain()],
      ['steering', this.steeringQueue.drain()],
      ['follow-up', this.followUpQueue.drain()],
    ] as const) {
      messages.push(...drained);
      diagnostics.push({ queue, count: drained.length });
    }

    return { messages, diagnostics };
  }

  snapshot(): AgentRunControlSnapshot {
    return {
      status: this.status,
      interrupted: this.interrupted,
      input: this.inputQueue.snapshot(),
      session: this.sessionQueue.snapshot(),
      followUp: this.followUpQueue.snapshot(),
      steering: this.steeringQueue.snapshot(),
      deferred: this.deferredQueue.snapshot(),
      sessionDrained: this.sessionDrained,
    };
  }

  restore(snapshot: AgentRunControlSnapshot): void {
    this.status = snapshot.status;
    this.interrupted = snapshot.interrupted;
    this.inputQueue.restore(snapshot.input);
    this.sessionQueue.restore(snapshot.session);
    this.followUpQueue.restore(snapshot.followUp);
    this.steeringQueue.restore(snapshot.steering);
    this.deferredQueue.restore(snapshot.deferred);
    this.sessionDrained = snapshot.sessionDrained;
  }

  private createRecoveryMessages(resume?: DeferredRunResults): AgentMessage[] {
    if (resume === undefined) {
      return [];
    }
    if (resume.deferred !== undefined) {
      this.deferredQueue.restore(resume.deferred);
    }
    const messages: AgentMessage[] = [];
    for (const item of this.deferredQueue.drain()) {
      if (item.kind === 'approval') {
        const decision = resume.approvals?.[item.toolCallId];
        const approved =
          typeof decision === 'boolean'
            ? decision
            : (decision?.approved ?? false);
        const output = approved
          ? (resume.toolResults?.[item.toolCallId] ?? { approved: true })
          : createDeniedOutput(
              typeof decision === 'object' ? decision.reason : undefined,
            );
        messages.push(
          createToolCallMessage(item.toolCallId, item.toolName, item.input),
        );
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              output: approved ? createToolOutput(output) : output,
            },
          ],
        } as unknown as AgentMessage);
        continue;
      }
      if (item.kind === 'tool-call') {
        messages.push(
          createToolCallMessage(item.toolCallId, item.toolName, item.input),
        );
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              output: createToolOutput(
                resume.toolResults?.[item.toolCallId] ?? null,
              ),
            },
          ],
        } as unknown as AgentMessage);
        continue;
      }
      messages.push(...item.messages);
    }
    return messages;
  }
}

function createToolCallMessage(
  toolCallId: string,
  toolName: string,
  input: unknown,
): AgentMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId,
        toolName,
        input,
      },
    ],
  } as unknown as AgentMessage;
}

function createToolOutput(output: unknown): unknown {
  if (typeof output === 'string') {
    return { type: 'text', value: output };
  }
  return { type: 'json', value: toJsonValue(output) };
}

function createDeniedOutput(reason: string | undefined): unknown {
  return reason === undefined
    ? { type: 'execution-denied' }
    : { type: 'execution-denied', reason };
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}
