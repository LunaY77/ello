import { describe, expect, it } from 'vitest';

import {
  CLIENT_REQUEST_SCHEMAS,
  type Capability,
  type ClientMethod,
} from '../../src/protocol/v1/index.js';
import type { ServerConnection } from '../../src/server/connection/server-connection.js';
import type { RpcServices } from '../../src/server/methods/server-services.js';
import {
  capabilityFor,
  CLIENT_METHOD_CAPABILITIES,
  RpcRouter,
} from '../../src/server/rpc/router.js';
import type { ThreadManager } from '../../src/server/runtime/thread-manager.js';

const READ_METHODS = [
  'server/read',
  'thread/read',
  'thread/list',
  'thread/loaded/list',
  'thread/turns/list',
  'thread/items/list',
  'thread/export',
  'artifact/read',
  'thread/goal/get',
  'thread/plan/read',
  'thread/plan/preview',
  'config/read',
  'config/sources',
  'model/list',
  'provider/list',
  'agent/list',
  'tool/list',
  'skills/list',
  'skills/get',
  'memory/status',
  'task/list',
  'task/get',
  'fs/readFile',
  'fs/readDirectory',
  'fs/getMetadata',
  'fs/search',
  'repo/list',
  'repo/read',
  'repo/remote/read',
  'repo/export',
  'workspace/list',
  'workspace/archived/list',
  'workspace/read',
  'workspace/path',
  'workspace/status',
] as const satisfies readonly ClientMethod[];

describe('RPC capability contract', () => {
  it('逐项覆盖完整 method catalog，且只有握手不需要 capability', () => {
    expect(Object.keys(CLIENT_METHOD_CAPABILITIES)).toEqual(
      Object.keys(CLIENT_REQUEST_SCHEMAS),
    );
    expect(
      Object.entries(CLIENT_METHOD_CAPABILITIES)
        .filter(([, capability]) => capability === null)
        .map(([method]) => method),
    ).toEqual(['initialize']);
    expect(
      Object.entries(CLIENT_METHOD_CAPABILITIES)
        .filter(([, capability]) => capability === 'read')
        .map(([method]) => method)
        .sort(),
    ).toEqual([...READ_METHODS].sort());
  });

  it('read-only 连接拒绝所有 submit/write/admin method', async () => {
    const services = new RecordingServices();
    const router = createRouter(services);
    const connection = readOnlyConnection();

    for (const [method, capability] of Object.entries(
      CLIENT_METHOD_CAPABILITIES,
    ) as Array<[ClientMethod, Capability | null]>) {
      if (capability === null || capability === 'read') continue;
      await expect(
        router.dispatch(connection, method, {}),
      ).rejects.toMatchObject({
        type: 'permissionDenied',
        details: { method, capability },
      });
    }
    expect(services.methods).toEqual([]);
  });

  it('read-only 连接可调用 repo/workspace 的真实 read/list 路由', async () => {
    const services = new RecordingServices();
    const router = createRouter(services);
    const connection = readOnlyConnection();

    await router.dispatch(connection, 'repo/list', {});
    await router.dispatch(connection, 'repo/read', { repo: 'repo_test' });
    await router.dispatch(connection, 'workspace/list', {});
    await router.dispatch(connection, 'workspace/read', {
      workspace: 'workspace_test',
    });

    expect(services.methods).toEqual([
      'repo/list',
      'repo/read',
      'workspace/list',
      'workspace/read',
    ]);
    expect(capabilityFor('repo/list')).toBe('read');
    expect(capabilityFor('workspace/status')).toBe('read');
  });
});

function createRouter(services: RpcServices): RpcRouter {
  return new RpcRouter({
    threads: {} as ThreadManager,
    version: 'test',
    startedAt: Date.now(),
    requestShutdown: () => undefined,
    services,
  });
}

function readOnlyConnection(): ServerConnection {
  return {
    state: { capabilities: new Set<Capability>(['read']) },
  } as unknown as ServerConnection;
}

class RecordingServices implements RpcServices {
  readonly methods: ClientMethod[] = [];

  dispatch(
    _connection: ServerConnection,
    method: ClientMethod,
  ): Promise<unknown> {
    this.methods.push(method);
    return Promise.resolve({});
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
