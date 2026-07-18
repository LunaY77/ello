import { ZodError } from 'zod';

import {
  AppServerError,
  CLIENT_REQUEST_SCHEMAS,
  SERVER_REQUEST_SCHEMAS,
  parseClientParams,
  parseServerRequestParams,
  type Capability,
  type ClientMethod,
  type ParsedClientParams,
  type PendingServerRequest,
  type ServerRequestMethod,
} from '../../protocol/v1/index.js';
import type { ServerConnection } from '../connection/server-connection.js';
import type { RpcServices } from '../methods/server-services.js';
import { ThreadManager } from '../runtime/thread-manager.js';

export interface RpcRouterOptions {
  readonly threads: ThreadManager;
  readonly version: string;
  readonly startedAt: number;
  readonly requestShutdown: (reason: string) => void;
  readonly services: RpcServices;
}

/**
 * Client method 的权限契约必须逐项声明。`initialize` 属于握手流程，不经过
 * RpcRouter；其余方法缺少分类时会直接产生类型错误，禁止用前缀或 read 兜底。
 */
export const CLIENT_METHOD_CAPABILITIES = {
  initialize: null,
  'server/read': 'read',
  'server/shutdown': 'admin',
  'thread/start': 'write',
  'thread/resume': 'write',
  'thread/read': 'read',
  'thread/list': 'read',
  'thread/loaded/list': 'read',
  'thread/fork': 'write',
  'thread/unsubscribe': 'write',
  'thread/archive': 'write',
  'thread/unarchive': 'write',
  'thread/delete': 'write',
  'thread/turns/list': 'read',
  'thread/items/list': 'read',
  'thread/export': 'read',
  'artifact/read': 'read',
  'thread/compact/start': 'write',
  'thread/shellCommand': 'write',
  'thread/settings/update': 'write',
  'turn/start': 'submit',
  'turn/steer': 'submit',
  'turn/interrupt': 'submit',
  'thread/goal/get': 'read',
  'thread/goal/set': 'write',
  'thread/goal/clear': 'write',
  'thread/plan/read': 'read',
  'thread/plan/preview': 'read',
  'config/read': 'read',
  'config/write': 'write',
  'config/init': 'write',
  'config/sources': 'read',
  'model/list': 'read',
  'provider/list': 'read',
  'agent/list': 'read',
  'tool/list': 'read',
  'skills/list': 'read',
  'skills/get': 'read',
  'skills/reload': 'write',
  'memory/status': 'read',
  'memory/reload': 'write',
  'memory/dream/start': 'write',
  'task/list': 'read',
  'task/get': 'read',
  'task/create': 'write',
  'task/update': 'write',
  'task/delete': 'write',
  'task/claim': 'write',
  'task/reset': 'write',
  'fs/readFile': 'read',
  'fs/readDirectory': 'read',
  'fs/getMetadata': 'read',
  'fs/search': 'read',
  'fs/watch': 'write',
  'fs/unwatch': 'write',
  'repo/add': 'write',
  'repo/list': 'read',
  'repo/read': 'read',
  'repo/rename': 'write',
  'repo/remove': 'write',
  'repo/fetch': 'write',
  'repo/fetchLocal': 'write',
  'repo/remote/read': 'read',
  'repo/remote/add': 'write',
  'repo/remote/set': 'write',
  'repo/remote/remove': 'write',
  'repo/export': 'read',
  'repo/import': 'write',
  'workspace/create': 'write',
  'workspace/list': 'read',
  'workspace/archived/list': 'read',
  'workspace/read': 'read',
  'workspace/path': 'read',
  'workspace/status': 'read',
  'workspace/repo/add': 'write',
  'workspace/repo/create': 'write',
  'workspace/repo/remove': 'write',
  'workspace/rename': 'write',
  'workspace/archive': 'write',
  'workspace/delete': 'write',
  'workspace/reconcile': 'write',
  'workspace/repair': 'write',
  'workspace/tmux/new': 'write',
} as const satisfies Record<ClientMethod, Capability | null>;

/** method handler 只接收已由共享 schema 验证过的 params。 */
export class RpcRouter {
  private readonly threads: ThreadManager;

  constructor(private readonly options: RpcRouterOptions) {
    this.threads = options.threads;
  }

  async dispatch(
    connection: ServerConnection,
    method: ClientMethod,
    rawParams: unknown,
  ): Promise<unknown> {
    this.requireCapability(connection, method);
    const params = validateClientParams(method, rawParams);
    switch (method) {
      case 'server/read':
        return {
          protocolVersion: 1,
          version: this.options.version,
          state: 'ready',
          uptimeMs: Date.now() - this.options.startedAt,
          capabilities: [...connection.state.capabilities],
        };
      case 'server/shutdown': {
        const shutdown = params as ParsedClientParams<'server/shutdown'>;
        this.options.requestShutdown(shutdown.reason ?? 'client request');
        return { ok: true };
      }
      case 'thread/start': {
        const start = params as ParsedClientParams<'thread/start'>;
        const attachment = await this.threads.start(
          connection.id,
          start,
          (notification) => connection.sendNotification(notification),
          serverRequestListener(connection),
        );
        if (start.subscribe) {
          connection.state.subscribedThreads.add(attachment.snapshot.thread.id);
        }
        return attachment.snapshot;
      }
      case 'thread/resume': {
        const resume = params as ParsedClientParams<'thread/resume'>;
        const attachment = await this.threads.resume(
          connection.id,
          resume,
          (notification) => connection.sendNotification(notification),
          serverRequestListener(connection),
        );
        if (resume.subscribe) {
          connection.state.subscribedThreads.add(resume.threadId);
        }
        return attachment.snapshot;
      }
      case 'thread/read':
        return this.threads.read(params as ParsedClientParams<'thread/read'>);
      case 'thread/list':
        return this.threads.list(params as ParsedClientParams<'thread/list'>);
      case 'thread/loaded/list':
        return { data: await this.threads.loaded() };
      case 'thread/fork': {
        const fork = params as ParsedClientParams<'thread/fork'>;
        const attachment = await this.threads.fork(
          connection.id,
          fork,
          (notification) => connection.sendNotification(notification),
          serverRequestListener(connection),
        );
        if (fork.subscribe) {
          connection.state.subscribedThreads.add(attachment.snapshot.thread.id);
        }
        return attachment.snapshot;
      }
      case 'thread/unsubscribe': {
        const unsubscribe = params as ParsedClientParams<'thread/unsubscribe'>;
        await this.threads.unsubscribe(connection.id, unsubscribe.threadId);
        connection.state.subscribedThreads.delete(unsubscribe.threadId);
        return { ok: true };
      }
      case 'thread/archive': {
        const archive = params as ParsedClientParams<'thread/archive'>;
        return { thread: await this.threads.archive(archive.threadId) };
      }
      case 'thread/unarchive': {
        const unarchive = params as ParsedClientParams<'thread/unarchive'>;
        return { thread: await this.threads.unarchive(unarchive.threadId) };
      }
      case 'thread/delete': {
        const deletion = params as ParsedClientParams<'thread/delete'>;
        await this.threads.deleteAny(deletion.threadId);
        return { ok: true };
      }
      case 'thread/turns/list': {
        const list = params as ParsedClientParams<'thread/turns/list'>;
        const snapshot = await this.threads.read({
          threadId: list.threadId,
          includeTurns: true,
          includeItems: false,
        });
        return page(snapshot.turns, list.cursor, list.limit);
      }
      case 'thread/items/list': {
        const list = params as ParsedClientParams<'thread/items/list'>;
        const snapshot = await this.threads.read({
          threadId: list.threadId,
          includeTurns: true,
          includeItems: true,
        });
        const items = snapshot.turns
          .filter(
            (turn) => list.turnId === undefined || turn.id === list.turnId,
          )
          .flatMap((turn) => turn.items);
        return page(items, list.cursor, list.limit);
      }
      case 'thread/settings/update': {
        const update = params as ParsedClientParams<'thread/settings/update'>;
        return this.threads.updateSettings(connection.id, update);
      }
      case 'turn/start': {
        const start = params as ParsedClientParams<'turn/start'>;
        const turn = await this.threads.startTurn(start.threadId, start.input, {
          ...(start.model === undefined ? {} : { model: start.model }),
          ...(start.profile === undefined ? {} : { profile: start.profile }),
          ...(start.mode === undefined ? {} : { mode: start.mode }),
        });
        return { turn };
      }
      case 'turn/steer': {
        const steer = params as ParsedClientParams<'turn/steer'>;
        await this.threads.steerTurn(
          steer.threadId,
          steer.expectedTurnId,
          steer.input,
        );
        return { ok: true };
      }
      case 'turn/interrupt': {
        const interrupt = params as ParsedClientParams<'turn/interrupt'>;
        return {
          turn: await this.threads.interruptTurn(
            interrupt.threadId,
            interrupt.turnId,
            interrupt.reason,
          ),
        };
      }
      default:
        return this.options.services.dispatch(connection, method, params);
    }
  }

  private requireCapability(
    connection: ServerConnection,
    method: ClientMethod,
  ): void {
    const capability = capabilityFor(method);
    if (connection.state.capabilities.has(capability)) return;
    throw new AppServerError({
      type: 'permissionDenied',
      message: `Method ${method} requires ${capability} capability.`,
      details: { method, capability },
    });
  }
}

function validateClientParams<M extends ClientMethod>(
  method: M,
  rawParams: unknown,
): ParsedClientParams<M> {
  try {
    return parseClientParams(method, rawParams);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    throw new AppServerError({
      type: 'invalidParams',
      message: 'Request params do not match the protocol schema.',
      details: { method, issues: error.issues },
      cause: error,
    });
  }
}

function serverRequestListener(connection: ServerConnection) {
  if (
    !connection.state.capabilities.has('approve') ||
    connection.state.client?.capabilities.supportsServerRequests !== true
  ) {
    return undefined;
  }
  return (request: PendingServerRequest): Promise<unknown> => {
    if (!(request.method in SERVER_REQUEST_SCHEMAS)) {
      throw new AppServerError({
        type: 'invalidRequest',
        message: `Unknown persisted Server Request method ${request.method}.`,
      });
    }
    const method = request.method as ServerRequestMethod;
    const params = parseServerRequestParams(method, request.params);
    return connection.request(request.id, method, params);
  };
}

export function isClientMethod(method: string): method is ClientMethod {
  return method in CLIENT_REQUEST_SCHEMAS;
}

export function capabilityFor(method: ClientMethod): Capability {
  const capability = CLIENT_METHOD_CAPABILITIES[method];
  if (capability !== null) return capability;
  throw new AppServerError({
    type: 'internal',
    message: `Method ${method} does not use RpcRouter capability checks.`,
    details: { method },
  });
}

function page<T>(
  values: readonly T[],
  cursor: string | undefined,
  limit: number,
): { readonly data: readonly T[]; readonly nextCursor?: string } {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AppServerError({
      type: 'invalidParams',
      message: `Invalid pagination cursor ${String(cursor)}.`,
    });
  }
  const data = values.slice(offset, offset + limit);
  const nextOffset = offset + data.length;
  return {
    data,
    ...(nextOffset < values.length ? { nextCursor: String(nextOffset) } : {}),
  };
}
