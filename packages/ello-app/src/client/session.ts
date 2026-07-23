/**
 * 连接生命周期运行时:创建 transport/client/controller,把所有入站事件
 * 接入单一 event-reducer,并暴露 typed Client 给 feature operations。
 * 协议违约(reducer 抛 ProtocolViolationError)直接让连接进入 fatal;
 * 重连 = 完整重读列表与快照,不做增量补偿。
 */
import { ELLO_PROTOCOL_VERSION } from '@ello/agent/protocol';
import type { ClientResult, InitializeParamsSchema } from '@ello/agent/protocol';
import type { z } from 'zod';

import { AppServerClient } from './app-server-client.js';
import { applyStoreEvent, ProtocolViolationError, type StoreEvent } from './event-reducer.js';
import { ServerRequestController } from './server-request-controller.js';
import type { AppTransport } from './transport.js';
import { DesktopSidecarTransport } from './transports/desktop-sidecar.js';

import { serverProjectionReset, useAppStore } from '@/store/store';

export const APP_VERSION = '0.1.0';

interface ActiveSession {
  readonly client: AppServerClient;
  readonly controller: ServerRequestController;
  readonly transport: AppTransport;
  readonly detach: () => void;
}

let active: ActiveSession | undefined;
let starting: Promise<void> | undefined;

export function getAppClient(): AppServerClient {
  if (active === undefined || active.client.state !== 'ready') {
    throw new Error('App Server client is not connected.');
  }
  return active.client;
}

export function getServerRequestController(): ServerRequestController {
  if (active === undefined || active.client.state !== 'ready') {
    throw new Error('App Server client is not connected.');
  }
  return active.controller;
}

/** 协议事件唯一入口:reducer 抛出的协议违约升级为 fatal 连接状态。 */
export function dispatchStoreEvent(event: StoreEvent): void {
  try {
    useAppStore.setState((prev) => applyStoreEvent(prev, event));
  } catch (error) {
    if (error instanceof ProtocolViolationError) {
      active?.client.fail(error);
    }
    throw error;
  }
}

export function startSession(): Promise<void> {
  if (starting !== undefined) return starting;
  const task = startSessionOnce();
  starting = task;
  void task.then(
    () => {
      if (starting === task) starting = undefined;
    },
    () => {
      if (starting === task) starting = undefined;
    },
  );
  return task;
}

async function startSessionOnce(): Promise<void> {
  await stopSession('restarting');
  useAppStore.setState(serverProjectionReset);

  const transport = await createTransport();
  const client = new AppServerClient({ transport });
  const controller = new ServerRequestController(
    client,
    () => useAppStore.getState(),
    dispatchStoreEvent,
  );

  const detachNotification = client.onNotification((notification) =>
    dispatchStoreEvent({ kind: 'notification', notification, receivedAt: Date.now() }),
  );
  const detachRequests = controller.attach();
  const detachClose = client.onClose((error) => {
    useAppStore.setState((state) => ({
      connection: {
        phase: error === undefined ? 'idle' : 'fatal',
        serverInfo: state.connection.serverInfo,
        fatalError: error?.message ?? null,
      },
    }));
  });
  active = {
    client,
    controller,
    transport,
    detach: () => {
      detachNotification();
      detachRequests();
      detachClose();
    },
  };

  try {
    await client.connect();
    useAppStore.setState((state) => ({
      connection: { ...state.connection, phase: 'handshake' },
    }));
    const initialize = await client.initialize(initializeParams());
    await loadBootstrapData();
    useAppStore.setState(() => ({
      connection: {
        phase: 'ready',
        serverInfo: initialize.serverInfo,
        fatalError: null,
      },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useAppStore.setState(() => ({
      connection: { phase: 'fatal', serverInfo: null, fatalError: message },
    }));
    await stopSession('startup failed');
    throw error instanceof Error ? error : new Error(message);
  }

}

export async function stopSession(reason: string): Promise<void> {
  const session = active;
  active = undefined;
  if (session === undefined) return;
  session.detach();
  await session.client.close(reason);
}

/** 连接就绪后的初始事实读取:工作区与会话列表。 */
async function loadBootstrapData(): Promise<void> {
  const client = getAppClient();
  const workspacesPromise = client.request('workspace/list', {});
  const threads: Array<ClientResult<'thread/list'>['data'][number]> = [];
  let cursor: string | undefined;
  do {
    const page = await client.request('thread/list',
      cursor === undefined ? {} : { cursor },
    );
    threads.push(...page.data);
    if (cursor !== undefined && page.nextCursor === cursor) {
      throw new Error(`App Server returned a repeated thread list cursor ${cursor}.`);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  const workspaces = await workspacesPromise;
  dispatchStoreEvent({ kind: 'workspaces-listed', workspaces: workspaces.data });
  dispatchStoreEvent({
    kind: 'threads-listed',
    threads,
    reset: true,
  });
}

async function createTransport(): Promise<AppTransport> {
  const transport = new DesktopSidecarTransport();
  await transport.start();
  return transport;
}

function initializeParams(): z.input<typeof InitializeParamsSchema> {
  return {
    clientInfo: { name: 'ello-app', title: 'Ello', version: APP_VERSION },
    protocolVersion: ELLO_PROTOCOL_VERSION,
    capabilities: {
      experimentalApi: false,
      supportsServerRequests: true,
      supportsUserInput: true,
      optOutNotificationMethods: [],
      platform: 'desktop',
    },
  };
}
