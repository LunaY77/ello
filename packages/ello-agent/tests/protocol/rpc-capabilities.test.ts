/**
 * 本文件验证 rpc-capabilities 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { describe, expect, it } from 'vitest';

import {
  CLIENT_REQUEST_SCHEMAS,
  type Capability,
  type ClientMethod,
} from '../../src/protocol/v1/index.js';
import {
  assertRouteCapability,
  dispatchRoute,
} from '../../src/server/rpc/dispatch.js';
import {
  capabilityFor,
  CLIENT_METHOD_CAPABILITIES,
  isRoutableClientMethod,
  route,
  type RoutableClientMethod,
  type RpcRouteFragment,
} from '../../src/server/rpc/route.js';
import { createTestPeer } from '../support/rpc.js';

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
  'config/settings',
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
] as const satisfies ReadonlyArray<ClientMethod>;

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

  it('read-only peer 拒绝所有 submit/write/admin method', () => {
    const peer = createTestPeer({ capabilities: ['read'] });

    for (const [method, capability] of Object.entries(
      CLIENT_METHOD_CAPABILITIES,
    ) as Array<[ClientMethod, Capability | null]>) {
      if (!isRoutableClientMethod(method)) continue;
      if (capability === null || capability === 'read') continue;
      expect(() =>
        assertRouteCapability(peer, method, capability),
      ).toThrowError(
        expect.objectContaining({
          type: 'permissionDenied',
          details: { method, capability },
        }),
      );
    }
  });

  it('read-only peer 可调用 repo/workspace 的 typed read route', async () => {
    const methods: Array<RoutableClientMethod> = [];
    const routes = {
      'repo/list': route('read', () => {
        methods.push('repo/list');
        return { data: [] };
      }),
      'workspace/list': route('read', () => {
        methods.push('workspace/list');
        return { data: [] };
      }),
    } satisfies RpcRouteFragment<'repo/list' | 'workspace/list'>;
    const peer = createTestPeer({ capabilities: ['read'] });

    await dispatchRoute(routes, peer, 'repo/list', {});
    await dispatchRoute(routes, peer, 'workspace/list', {});

    expect(methods).toEqual(['repo/list', 'workspace/list']);
    expect(capabilityFor('repo/list')).toBe('read');
    expect(capabilityFor('workspace/status')).toBe('read');
  });
});
