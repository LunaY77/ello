/**
 * 本文件负责 Workspace 领域内 repository registry 的 typed route 适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { invalidParams } from '../../protocol/errors.js';
import {
  bindFeatureRoute,
  type FeatureHandlerMap,
} from '../../server/rpc/route.js';
import type { RpcRouteFragment } from '../../server/rpc/route.js';
import { stringifyYamlConfig } from '../config/index.js';

import { RepoStore } from './repositories.js';
import type { RepositoryStore } from './repository-store.js';
import type { Repository } from './repository.js';

type RepoMethod =
  | 'repo/add'
  | 'repo/list'
  | 'repo/read'
  | 'repo/rename'
  | 'repo/remove'
  | 'repo/fetch'
  | 'repo/fetchLocal'
  | 'repo/remote/read'
  | 'repo/remote/add'
  | 'repo/remote/set'
  | 'repo/remote/remove'
  | 'repo/export'
  | 'repo/import';

interface RepoContext {
  readonly repositories: RepositoryStore;
}

/** Repo handler 每次从共享 repository store 读取当前事实，不缓存 Git 状态。 */
const repoHandlers = {
  'repo/add': async (context, params) => {
    const store = repoStore(context);
    let repository = await store.add(params.source, params.key);
    if (params.remoteUrl !== undefined && repository.remoteUrl === null) {
      repository = await store.remoteAdd(repository.key, params.remoteUrl);
    }
    return { repository: protocolRepository(repository) };
  },
  'repo/list': (context) => ({
    data: repoStore(context).list().map(protocolRepository),
  }),
  'repo/read': (context, params) => {
    const repository = repoStore(context).show(params.repo);
    if (repository === null) {
      throw invalidParams(`Unknown repo ${params.repo}.`);
    }
    return { repository: protocolRepository(repository) };
  },
  'repo/rename': (context, params) => ({
    repository: protocolRepository(
      repoStore(context).rename(params.repo, params.name),
    ),
  }),
  'repo/remove': async (context, params) => {
    await repoStore(context).remove(params.repo);
    return { ok: true };
  },
  'repo/fetch': async (context, params) => {
    const store = repoStore(context);
    await store.fetch([params.repo]);
    const repository = store.show(params.repo);
    if (repository === null) {
      throw invalidParams(`Unknown repo ${params.repo}.`);
    }
    return { repository: protocolRepository(repository) };
  },
  'repo/fetchLocal': async (context, params) => ({
    repository: protocolRepository(
      await repoStore(context).fetchLocal(params.repo, params.path),
    ),
  }),
  'repo/remote/read': (context, params) => {
    const remote = repoStore(context).remoteShow(params.repo);
    return {
      remotes: remote.remoteUrl === null ? {} : { origin: remote.remoteUrl },
    };
  },
  'repo/remote/add': async (context, params) => {
    assertOrigin(params.name);
    return {
      repository: protocolRepository(
        await repoStore(context).remoteAdd(params.repo, params.url),
      ),
    };
  },
  'repo/remote/set': async (context, params) => {
    assertOrigin(params.name);
    return {
      repository: protocolRepository(
        await repoStore(context).remoteSet(params.repo, params.url),
      ),
    };
  },
  'repo/remote/remove': async (context, params) => {
    assertOrigin(params.name);
    return {
      repository: protocolRepository(
        await repoStore(context).remoteRemove(params.repo),
      ),
    };
  },
  'repo/export': (context, params) =>
    exportRepositories(repoStore(context), params.repos ?? []),
  'repo/import': (context, params) =>
    importRepositories(repoStore(context), params.document),
} satisfies FeatureHandlerMap<RepoContext, RepoMethod>;

function repoStore(context: RepoContext): RepoStore {
  return new RepoStore(context.repositories);
}

async function exportRepositories(store: RepoStore, keys: readonly string[]) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'ello-repo-export-'));
  const outputDir = path.join(temporaryRoot, 'portable');
  try {
    const exported = await store.export(keys, outputDir);
    return {
      document: {
        formatVersion: exported.formatVersion,
        exportedAt: exported.exportedAt,
        repositories: await Promise.all(
          exported.repositories.map(async (repository) => ({
            key: repository.key,
            remoteUrl: repository.remoteUrl,
            defaultBranch: repository.defaultBranch,
            ...(repository.bundle === undefined
              ? {}
              : {
                  bundle: {
                    encoding: 'base64' as const,
                    data: await readFile(
                      path.join(outputDir, repository.bundle),
                      'base64',
                    ),
                  },
                }),
          })),
        ),
      },
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function importRepositories(store: RepoStore, input: unknown) {
  const document = readRepositoryImport(input);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'ello-repo-import-'));
  const inputDir = path.join(temporaryRoot, 'portable');
  try {
    await mkdir(path.join(inputDir, 'bundles'), { recursive: true });
    const repositories = [];
    for (const [index, repository] of document.repositories.entries()) {
      let bundlePath: string | undefined;
      if (repository.bundle !== undefined) {
        bundlePath = `bundles/repository-${index}.bundle`;
        await writeFile(
          path.join(inputDir, bundlePath),
          decodeBase64Bundle(repository.bundle.data),
          { flag: 'wx' },
        );
      }
      repositories.push({
        key: repository.key,
        remoteUrl: repository.remoteUrl,
        defaultBranch: repository.defaultBranch,
        ...(bundlePath === undefined ? {} : { bundle: bundlePath }),
      });
    }
    await writeFile(
      path.join(inputDir, 'repos.yaml'),
      stringifyYamlConfig({
        formatVersion: 1,
        exportedAt: document.exportedAt,
        repositories,
      }),
      'utf8',
    );
    const imported = await store.import(inputDir);
    return { data: imported.map(protocolRepository) };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const RepositoryImportSchema = z
  .object({
    formatVersion: z.literal(1),
    exportedAt: z.string(),
    repositories: z.array(
      z
        .object({
          key: z.string(),
          remoteUrl: z.string().nullable(),
          defaultBranch: z.string(),
          bundle: z
            .object({
              encoding: z.literal('base64'),
              data: z.string(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .superRefine((repository, context) => {
          if (
            repository.remoteUrl === null &&
            repository.bundle === undefined
          ) {
            context.addIssue({
              code: 'custom',
              path: ['bundle'],
              message: 'Local-only repository requires a base64 bundle.',
            });
          }
          if (
            repository.remoteUrl !== null &&
            repository.bundle !== undefined
          ) {
            context.addIssue({
              code: 'custom',
              path: ['bundle'],
              message: 'Remote repository must not contain a bundle.',
            });
          }
        }),
    ),
  })
  .strict();

function readRepositoryImport(input: unknown) {
  const result = RepositoryImportSchema.safeParse(input);
  if (!result.success) {
    throw invalidParams(
      `Invalid repository import document: ${result.error.message}`,
    );
  }
  return result.data;
}

function decodeBase64Bundle(value: string): Buffer {
  if (
    value.length > 128 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) {
    throw invalidParams('Repository bundle is not valid bounded base64.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw invalidParams('Repository bundle is not canonical base64.');
  }
  return decoded;
}

function assertOrigin(name: string): void {
  if (name !== 'origin') {
    throw invalidParams('Ello repositories expose only the origin remote.');
  }
}

function protocolRepository(repository: Repository) {
  return {
    id: repository.id,
    key: repository.key,
    sourceUrl: repository.remoteUrl,
    mirrorPath: repository.mirrorPath,
    defaultBranch: repository.defaultBranch,
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
  };
}

/**
 * 构造 Repository route 适配模块中的 `createRepositoryRoutes` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `repositories`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `createRepositoryRoutes` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Repository route 适配 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createRepositoryRoutes(
  repositories: RepositoryStore,
): RpcRouteFragment<RepoMethod> {
  const bind = <M extends RepoMethod>(method: M) =>
    bindFeatureRoute(repoHandlers, () => ({ repositories }), method);
  return {
    'repo/add': bind('repo/add'),
    'repo/list': bind('repo/list'),
    'repo/read': bind('repo/read'),
    'repo/rename': bind('repo/rename'),
    'repo/remove': bind('repo/remove'),
    'repo/fetch': bind('repo/fetch'),
    'repo/fetchLocal': bind('repo/fetchLocal'),
    'repo/remote/read': bind('repo/remote/read'),
    'repo/remote/add': bind('repo/remote/add'),
    'repo/remote/set': bind('repo/remote/set'),
    'repo/remote/remove': bind('repo/remote/remove'),
    'repo/export': bind('repo/export'),
    'repo/import': bind('repo/import'),
  };
}
