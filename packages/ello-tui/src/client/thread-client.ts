import type { AppServerClient } from '../api/client.js';
import type {
  ApprovalDecision,
  ClientMethod,
  ClientParams,
  ClientResult,
  SessionMode,
  ThreadSnapshot,
  UserInputResolution,
  UserInput,
} from '../api/protocol-types.js';
import {
  isApprovalRequest,
  type ClientServerRequest,
} from '../api/server-requests.js';

import type {
  ThreadClientEvent,
  ThreadClientListener,
} from './client-events.js';
import { reduceNotification, type ClientProjection } from './event-reducer.js';

export interface ThreadClientOptions {
  readonly server: AppServerClient;
  readonly snapshot: ThreadSnapshot;
}

/** UI 唯一使用的 thread facade；threadId 在实例创建后不可变。 */
export class ThreadClient {
  readonly threadId: string;
  readonly cwd: string;
  private projection: ClientProjection;
  private readonly listeners = new Set<ThreadClientListener>();
  private readonly pendingRequests = new Map<string, ClientServerRequest>();
  private readonly stopNotificationListener: () => void;
  private readonly stopServerRequestListener: () => void;
  private recoveryTask: Promise<void> | undefined;

  constructor(
    private readonly server: AppServerClient,
    snapshot: ThreadSnapshot,
  ) {
    this.threadId = snapshot.thread.id;
    this.cwd = snapshot.thread.cwd;
    this.projection = { snapshot, stale: false };
    this.stopNotificationListener = server.onNotification((notification) => {
      if (
        !('threadId' in notification.params) ||
        notification.params.threadId !== this.threadId
      )
        return;
      const result = reduceNotification(this.projection, notification);
      if (result.duplicate) return;
      this.projection = result.projection;
      this.emit({ type: 'notification', notification });
      if (result.gap !== undefined) {
        this.emit({ type: 'stale', ...result.gap });
        void this.recover().catch(() => undefined);
      }
    });
    this.stopServerRequestListener = server.onServerRequest((request) => {
      if (request.params.threadId !== this.threadId) return false;
      const typedRequest = request as ClientServerRequest;
      this.pendingRequests.set(request.id, typedRequest);
      this.emit({ type: 'serverRequest', request: typedRequest });
      return true;
    });
  }

  get snapshot(): ThreadSnapshot {
    return this.projection.snapshot;
  }
  get stale(): boolean {
    return this.projection.stale;
  }

  /**
   * App 层只能通过这个 typed facade 访问通用 RPC；原始 transport 和 request id
   * 仍然留在 AppServerClient 内部，避免 TUI 自己维护第二套协议解析。
   */
  request<M extends Exclude<ClientMethod, 'initialize'>>(
    method: M,
    params: ClientParams<M>,
  ): Promise<ClientResult<M>> {
    return this.server.request(method, params);
  }

  subscribe(listener: ThreadClientListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async loadHistory(): Promise<void> {
    const snapshot = await this.server.request('thread/read', {
      threadId: this.threadId,
      includeTurns: true,
      includeItems: true,
    });
    this.projection = { snapshot, stale: false };
    this.emit({ type: 'snapshot', snapshot });
  }

  async submit(
    input: string,
    metadata?: Record<string, string>,
  ): Promise<string> {
    return this.submitInput([{ type: 'text', text: input }], metadata);
  }

  async submitInput(
    input: readonly UserInput[],
    metadata?: Record<string, string>,
  ): Promise<string> {
    if (this.projection.stale)
      throw new Error('Thread history is stale; resume before submitting.');
    const params: ClientParams<'turn/start'> = {
      threadId: this.threadId,
      input,
      ...(metadata === undefined ? {} : { metadata }),
    };
    const result = await this.server.request('turn/start', params);
    return result.turn.id;
  }

  async steer(input: string): Promise<void> {
    return this.steerInput([{ type: 'text', text: input }]);
  }

  async steerInput(input: readonly UserInput[]): Promise<void> {
    const turn = activeTurn(this.projection.snapshot);
    if (turn === undefined) throw new Error('Thread has no active turn.');
    await this.server.request('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: turn.id,
      input,
    });
  }

  async interrupt(reason?: string): Promise<void> {
    const turn = activeTurn(this.projection.snapshot);
    if (turn === undefined) return;
    await this.server.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: turn.id,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  async approve(
    requestId: string,
    decision: ApprovalDecision['decision'],
  ): Promise<void> {
    const request = this.pendingRequests.get(requestId);
    if (request === undefined)
      throw new Error(`Unknown Server Request ${requestId}.`);
    if (!isApprovalRequest(request))
      throw new Error(`Server Request ${requestId} is not an approval.`);
    this.pendingRequests.delete(requestId);
    await request.respond({ decision });
  }

  async resolveUserInput(
    requestId: string,
    value: UserInputResolution,
  ): Promise<void> {
    const request = this.pendingRequests.get(requestId);
    if (request === undefined)
      throw new Error(`Unknown Server Request ${requestId}.`);
    if (request.method !== 'item/tool/requestUserInput')
      throw new Error(`Server Request ${requestId} is not user input.`);
    this.pendingRequests.delete(requestId);
    await request.respond(value);
  }

  async setMode(mode: SessionMode): Promise<void> {
    await this.updateSettings({ mode });
  }

  async setProfile(profile: string): Promise<void> {
    await this.updateSettings({ profile });
  }

  async setModel(model: string): Promise<void> {
    await this.updateSettings({ model });
  }

  async startNewThread(): Promise<ThreadClient> {
    const snapshot = await this.server.request('thread/start', {
      cwd: this.cwd,
      subscribe: true,
    });
    return new ThreadClient(this.server, snapshot);
  }

  async fork(lastTurnId?: string): Promise<ThreadClient> {
    const snapshot = await this.server.request('thread/fork', {
      threadId: this.threadId,
      subscribe: true,
      ...(lastTurnId === undefined ? {} : { lastTurnId }),
    });
    return new ThreadClient(this.server, snapshot);
  }

  async resume(threadId: string): Promise<ThreadClient> {
    const snapshot = await this.server.request('thread/resume', {
      threadId,
      subscribe: true,
    });
    return new ThreadClient(this.server, snapshot);
  }

  async close(): Promise<void> {
    this.stopNotificationListener();
    this.stopServerRequestListener();
    await this.server
      .request('thread/unsubscribe', { threadId: this.threadId })
      .catch(() => undefined);
  }

  private async updateSettings(
    settings: Omit<ClientParams<'thread/settings/update'>, 'threadId'>,
  ): Promise<void> {
    const updated = await this.server.request('thread/settings/update', {
      threadId: this.threadId,
      ...settings,
    });
    this.projection = {
      ...this.projection,
      snapshot: { ...this.projection.snapshot, settings: updated },
    };
    this.emit({ type: 'snapshot', snapshot: this.projection.snapshot });
  }

  private emit(event: ThreadClientEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private recover(): Promise<void> {
    if (this.recoveryTask !== undefined) return this.recoveryTask;
    const task = this.server
      .request('thread/resume', {
        threadId: this.threadId,
        subscribe: true,
      })
      .then((snapshot) => {
        this.projection = { snapshot, stale: false };
        this.emit({ type: 'snapshot', snapshot });
      })
      .catch((error: unknown) => {
        this.emit({
          type: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw error;
      })
      .finally(() => {
        this.recoveryTask = undefined;
      });
    this.recoveryTask = task;
    return task;
  }
}

function activeTurn(snapshot: ThreadSnapshot) {
  return [...snapshot.turns]
    .reverse()
    .find((turn) => turn.status === 'inProgress');
}

export function createThreadClient(options: ThreadClientOptions): ThreadClient {
  return new ThreadClient(options.server, options.snapshot);
}
