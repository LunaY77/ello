/**
 * 本文件负责 workspace feature 的typed route 适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { invalidParams } from '../../protocol/errors.js';
import { jsonArray, jsonClone } from '../../protocol/json-value.js';
import type { ParsedClientParams } from '../../protocol/v1/index.js';
import {
  bindFeatureRoute,
  type FeatureHandlerMap,
} from '../../server/rpc/route.js';
import type { RpcRouteFragment } from '../../server/rpc/route.js';
import { loadCodingAgentConfig } from '../config/index.js';

import { resolveWorkspaceMount } from './paths.js';
import { RepoStore } from './repositories.js';
import type { RepositoryStore } from './repository-store.js';
import type { WorkspaceRecordStore } from './store.js';

import { WorkspaceStore, type Workspace } from './index.js';

type WorkspaceMethod =
  | 'workspace/create'
  | 'workspace/list'
  | 'workspace/archived/list'
  | 'workspace/read'
  | 'workspace/path'
  | 'workspace/status'
  | 'workspace/repo/add'
  | 'workspace/repo/create'
  | 'workspace/repo/remove'
  | 'workspace/rename'
  | 'workspace/archive'
  | 'workspace/delete'
  | 'workspace/reconcile'
  | 'workspace/repair'
  | 'workspace/tmux/new';

interface WorkspaceContext {
  readonly repositories: RepositoryStore;
  readonly workspaces: WorkspaceRecordStore;
}

/** workspace handler 在每次请求装配 mount，配置变更无需重启 Server 才能生效。 */
const workspaceHandlers = {
  'workspace/create': async (context, params) => {
    const store = await workspaceStore(context);
    return {
      workspace: protocolWorkspace(
        await store.create(params.kind, params.name, params.repos, params.tmux),
      ),
    };
  },
  'workspace/list': async (context, params) => {
    const store = await workspaceStore(context);
    return {
      data: store
        .list({
          ...(params.kind === undefined ? {} : { kind: params.kind }),
          ...(params.status === undefined ? {} : { status: params.status }),
        })
        .map(protocolWorkspace),
    };
  },
  'workspace/archived/list': async (context, params) => {
    const store = await workspaceStore(context);
    const archived =
      params.workspace === undefined
        ? store.list({ status: 'archived' })
        : listArchivedWorkspace(store, params.workspace);
    return { data: archived.map(protocolWorkspace) };
  },
  'workspace/read': async (context, params) => {
    const store = await workspaceStore(context);
    return {
      workspace: protocolWorkspace(openWorkspace(store, params.workspace)),
    };
  },
  'workspace/path': async (context, params) => {
    const store = await workspaceStore(context);
    return { path: openWorkspace(store, params.workspace).rootPath };
  },
  'workspace/status': async (context, params) => {
    const store = await workspaceStore(context);
    const [status] = await store.status([
      openWorkspace(store, params.workspace),
    ]);
    if (status === undefined) {
      throw invalidParams(`Unknown workspace ${params.workspace}.`);
    }
    return { status: jsonClone(status) };
  },
  'workspace/repo/add': async (context, params) => {
    if (params.detached !== (params.role === 'reference')) {
      throw invalidParams(
        'detached must be true exactly for reference checkouts.',
      );
    }
    const store = await workspaceStore(context);
    const workspace = await store.addRepos(
      openWorkspace(store, params.workspace),
      workspaceRepositoryKeys(params),
      params.role,
    );
    return { workspace: protocolWorkspace(workspace) };
  },
  'workspace/repo/create': async (context, params) => {
    const store = await workspaceStore(context);
    return {
      workspace: protocolWorkspace(
        await store.createRepo(
          openWorkspace(store, params.workspace),
          params.key,
        ),
      ),
    };
  },
  'workspace/repo/remove': async (context, params) => {
    const store = await workspaceStore(context);
    return {
      workspace: protocolWorkspace(
        await store.removeRepos(
          openWorkspace(store, params.workspace),
          workspaceRepositoryKeys(params),
          params.force,
        ),
      ),
    };
  },
  'workspace/rename': async (context, params) => {
    const store = await workspaceStore(context);
    return {
      workspace: protocolWorkspace(
        await store.rename(openWorkspace(store, params.workspace), params.name),
      ),
    };
  },
  'workspace/archive': async (context, params) => {
    const store = await workspaceStore(context);
    return {
      workspace: protocolWorkspace(
        await store.archive(openWorkspace(store, params.workspace)),
      ),
    };
  },
  'workspace/delete': async (context, params) => {
    const store = await workspaceStore(context);
    await store.delete(
      params.archived
        ? openArchivedWorkspace(store, params.workspace)
        : openWorkspace(store, params.workspace),
      params.force,
    );
    return { ok: true };
  },
  'workspace/reconcile': async (context, params) => {
    const store = await workspaceStore(context);
    return {
      result: jsonClone(
        await store.reconcile(
          params.workspace === undefined
            ? store.listRepairable()
            : [openWorkspace(store, params.workspace)],
        ),
      ),
    };
  },
  'workspace/repair': async (context, params) => {
    const store = await workspaceStore(context);
    return {
      result: jsonClone(
        await store.repair(
          params.workspace === undefined
            ? store.listRepairable()
            : [openWorkspace(store, params.workspace)],
        ),
      ),
    };
  },
  'workspace/tmux/new': async (context, params) => {
    if (params.command !== undefined) {
      throw invalidParams(
        'workspace/tmux/new command is not supported by TmuxStore.',
      );
    }
    const store = await workspaceStore(context);
    const workspace = openWorkspace(store, params.workspace);
    const session = params.name ?? `${workspace.kind}-${workspace.name}`;
    await store.bindTmux(workspace, session);
    return { session };
  },
} satisfies FeatureHandlerMap<WorkspaceContext, WorkspaceMethod>;

async function workspaceStore(
  context: WorkspaceContext,
  cwd = process.cwd(),
): Promise<WorkspaceStore> {
  const config = await loadCodingAgentConfig({ cwd });
  const repos = new RepoStore(context.repositories);
  const store = new WorkspaceStore(
    context.workspaces,
    repos,
    resolveWorkspaceMount(config.workspace.mount),
  );
  await store.initializeMount();
  return store;
}

function workspaceRepositoryKeys(
  params:
    | ParsedClientParams<'workspace/repo/add'>
    | ParsedClientParams<'workspace/repo/remove'>,
): readonly string[] {
  if (params.repos !== undefined) return params.repos;
  if (params.repo !== undefined) return [params.repo];
  throw invalidParams('Workspace repository operation requires repo or repos.');
}

function protocolWorkspace(workspace: Workspace) {
  return {
    id: workspace.id,
    kind: workspace.kind,
    name: workspace.name,
    rootPath: workspace.rootPath,
    status: workspace.status,
    branch: workspace.branch,
    repositories: jsonArray(workspace.repos),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

function openWorkspace(store: WorkspaceStore, selector: string): Workspace {
  try {
    return store.openById(selector);
  } catch (idError) {
    const slash = selector.indexOf('/');
    if (slash <= 0 || slash === selector.length - 1) throw idError;
    return store.open(selector.slice(0, slash), selector.slice(slash + 1));
  }
}

function listArchivedWorkspace(
  store: WorkspaceStore,
  selector: string,
): readonly Workspace[] {
  const selected = openArchivedWorkspace(store, selector);
  return [selected];
}

function openArchivedWorkspace(
  store: WorkspaceStore,
  selector: string,
): Workspace {
  const slash = selector.indexOf('/');
  if (slash <= 0 || slash === selector.length - 1) {
    throw invalidParams(`Invalid archived workspace selector: ${selector}.`);
  }
  const parsed = parseWorkspaceSelector(selector);
  const archived = store
    .list({ status: 'archived' })
    .find(
      (workspace) =>
        workspace.kind === parsed.kind && workspace.name === parsed.name,
    );
  if (archived === undefined) {
    throw invalidParams(`Unknown archived workspace ${selector}.`);
  }
  return archived;
}

function parseWorkspaceSelector(selector: string): {
  readonly kind: 'feature' | 'fix' | 'refactor' | 'explore';
  readonly name: string;
} {
  const slash = selector.indexOf('/');
  const kind = selector.slice(0, slash);
  const name = selector.slice(slash + 1);
  if (
    name === '' ||
    selector.indexOf('/', slash + 1) !== -1 ||
    (kind !== 'feature' &&
      kind !== 'fix' &&
      kind !== 'refactor' &&
      kind !== 'explore')
  ) {
    throw invalidParams(`Invalid workspace selector: ${selector}.`);
  }
  return { kind, name };
}

/**
 * 构造 Workspace route 适配 模块 中的 `createWorkspaceRoutes` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `input`: `createWorkspaceRoutes` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `createWorkspaceRoutes` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Workspace route 适配 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createWorkspaceRoutes(input: {
  readonly repositories: RepositoryStore;
  readonly workspaces: WorkspaceRecordStore;
}): RpcRouteFragment<WorkspaceMethod> {
  const bind = <M extends WorkspaceMethod>(method: M) =>
    bindFeatureRoute(workspaceHandlers, () => input, method);
  return {
    'workspace/create': bind('workspace/create'),
    'workspace/list': bind('workspace/list'),
    'workspace/archived/list': bind('workspace/archived/list'),
    'workspace/read': bind('workspace/read'),
    'workspace/path': bind('workspace/path'),
    'workspace/status': bind('workspace/status'),
    'workspace/repo/add': bind('workspace/repo/add'),
    'workspace/repo/create': bind('workspace/repo/create'),
    'workspace/repo/remove': bind('workspace/repo/remove'),
    'workspace/rename': bind('workspace/rename'),
    'workspace/archive': bind('workspace/archive'),
    'workspace/delete': bind('workspace/delete'),
    'workspace/reconcile': bind('workspace/reconcile'),
    'workspace/repair': bind('workspace/repair'),
    'workspace/tmux/new': bind('workspace/tmux/new'),
  };
}
