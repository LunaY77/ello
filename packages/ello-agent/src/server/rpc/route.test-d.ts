/**
 * 本文件锁定 route 的纯类型边界。
 *
 * 声明只参与 TypeScript 编译，不创建运行期状态；正反例必须让公开契约的可赋值方向保持明确。
 * 新增联合成员或字段时，类型检查应直接暴露未同步的调用方。
 */
import type { RpcRouteFragment, RpcRouteTable } from './route.js';
import { route } from './route.js';

(() => {
  const routes = {
    'task/list': route<'task/list'>('read', (_peer, params) => {
      params.status satisfies
        | 'pending'
        | 'inProgress'
        | 'completed'
        | 'cancelled'
        | undefined;
      return { data: [] };
    }),
    'task/get': route<'task/get'>('read', (_peer, params) => ({
      task: {
        id: params.id,
        boardId: 'board_test',
        subject: 'test',
        description: '',
        status: 'pending',
        owner: null,
        blockedBy: [],
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    })),
  } satisfies RpcRouteFragment<'task/list' | 'task/get'>;

  routes satisfies RpcRouteFragment<'task/list' | 'task/get'>;
})();

(() => {
  // @ts-expect-error -- A complete route table cannot omit Client methods.
  const routes = {} satisfies RpcRouteTable;
  void routes;
})();

(() => {
  const routes = {
    // @ts-expect-error -- Every route must declare its capability.
    'task/list': {
      run: () => ({ data: [] }),
    },
  } satisfies RpcRouteFragment<'task/list'>;
  void routes;
})();

(() => {
  const routes = {
    // @ts-expect-error -- task/list must return the protocol result shape.
    'task/list': route<'task/list'>('read', () => ({ ok: true })),
  } satisfies RpcRouteFragment<'task/list'>;
  void routes;
})();

(() => {
  const routes = {
    'task/list': route<'task/list'>('read', (_peer, params) => {
      // @ts-expect-error -- task/list params do not contain taskId.
      void params.taskId;
      return { data: [] };
    }),
  } satisfies RpcRouteFragment<'task/list'>;
  void routes;
})();
