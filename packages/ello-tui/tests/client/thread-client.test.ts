import { describe, expect, it, vi } from 'vitest';

import type {
  AppServerClient,
  IncomingServerRequest,
} from '../../src/api/client.js';
import type {
  ServerNotification,
  ServerRequestMethod,
  ThreadSnapshot,
} from '../../src/api/protocol-types.js';
import { ThreadClient } from '../../src/client/thread-client.js';

const createdAt = '2026-07-18T00:00:00.000Z';

describe('ThreadClient recovery', () => {
  it('审批 response 发送前先消费 pending request', async () => {
    const recovery = deferred<ThreadSnapshot>();
    const response = deferred<void>();
    const server = new TestServer(recovery.promise);
    const client = new ThreadClient(
      server as unknown as AppServerClient,
      snapshot(1),
    );
    const respond = vi.fn(() => response.promise);
    server.emitServerRequest({
      id: 'srvreq_once',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_fixture',
        turnId: 'turn_fixture',
        itemId: 'item_fixture',
        command: ['git', 'status'],
        cwd: '/workspace',
        reason: 'test',
        availableDecisions: ['accept', 'decline'],
      },
      respond,
      reject: vi.fn(),
    });

    const first = client.approve('srvreq_once', 'accept');
    await expect(client.approve('srvreq_once', 'accept')).rejects.toThrow(
      'Unknown Server Request srvreq_once',
    );
    expect(respond).toHaveBeenCalledOnce();
    response.resolve(undefined);
    await first;
    await client.close();
  });

  it('seq gap 后只执行一次 thread/resume，恢复前禁止 submit', async () => {
    const recovery = deferred<ThreadSnapshot>();
    const server = new TestServer(recovery.promise);
    const client = new ThreadClient(
      server as unknown as AppServerClient,
      snapshot(1),
    );
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));

    server.emit(notification(3));
    server.emit(notification(5));

    await vi.waitFor(() => {
      expect(
        server.requests.filter(([method]) => method === 'thread/resume'),
      ).toHaveLength(1);
    });
    expect(client.stale).toBe(true);
    await expect(client.submit('must wait')).rejects.toThrow(
      'Thread history is stale',
    );

    recovery.resolve(snapshot(5));
    await vi.waitFor(() => expect(client.stale).toBe(false));
    expect(client.snapshot.seq).toBe(5);
    expect(events).toContain('stale');
    expect(events.at(-1)).toBe('snapshot');

    await client.close();
  });
});

class TestServer {
  readonly requests: Array<readonly [string, unknown]> = [];
  private readonly notificationListeners = new Set<
    (notification: ServerNotification) => void
  >();
  private readonly serverRequestListeners = new Set<
    (request: IncomingServerRequest<ServerRequestMethod>) => void
  >();

  constructor(private readonly recovery: Promise<ThreadSnapshot>) {}

  onNotification(
    listener: (notification: ServerNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(
    listener: (request: IncomingServerRequest<ServerRequestMethod>) => void,
  ): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  request(method: string, params: unknown): Promise<unknown> {
    this.requests.push([method, params]);
    if (method === 'thread/resume') return this.recovery;
    if (method === 'thread/unsubscribe') return Promise.resolve({ ok: true });
    throw new Error(`Unexpected request ${method}.`);
  }

  emit(value: ServerNotification): void {
    for (const listener of this.notificationListeners) listener(value);
  }

  emitServerRequest(request: IncomingServerRequest<ServerRequestMethod>): void {
    for (const listener of this.serverRequestListeners) listener(request);
  }
}

function snapshot(seq: number): ThreadSnapshot {
  return {
    thread: {
      id: 'thr_fixture',
      rootId: 'thr_fixture',
      cwd: '/workspace',
      name: 'fixture',
      preview: '',
      status: 'idle',
      archived: false,
      createdAt,
      updatedAt: createdAt,
    },
    settings: {
      mode: 'ask-before-changes',
      profile: 'main',
      model: 'mock/model',
      agent: 'build',
    },
    turns: [],
    pendingServerRequests: [],
    goal: null,
    plan: null,
    usage: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 0,
    },
    seq,
  };
}

function notification(seq: number): ServerNotification {
  return {
    method: 'thread/status/changed',
    params: {
      threadId: 'thr_fixture',
      seq,
      status: 'running',
      activeFlags: ['turn'],
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
