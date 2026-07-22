/**
 * 本文件负责 fs feature 的typed route 适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { watch } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { createEntityId } from '../../ids.js';
import { invalidParams } from '../../protocol/errors.js';
import {
  bindFeatureRoute,
  type FeatureHandlerMap,
} from '../../server/rpc/route.js';
import type { RpcPeer, RpcRouteFragment } from '../../server/rpc/route.js';
import type { ArtifactStore } from '../artifact/index.js';

import { existingPathInside, lexicalPathInside } from './paths.js';

const INLINE_ARTIFACT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

type FsMethod =
  | 'fs/readFile'
  | 'fs/readDirectory'
  | 'fs/getMetadata'
  | 'fs/search'
  | 'fs/watch'
  | 'fs/unwatch';

export type FsWatchers = Map<
  string,
  {
    readonly connectionId: string;
    readonly watcher: {
      /**
       * 停止底层文件系统监听器，不再向连接发布变更事件。
       *
       * Args:
       * - 无：监听器已经绑定目标路径和回调。
       *
       * Returns:
       * - 监听资源同步释放后返回，不产生业务结果。
       */
      close(): void;
    };
  }
>;

interface FsContext {
  readonly artifacts: ArtifactStore;
  readonly peer: RpcPeer;
  readonly watchers: FsWatchers;
}

/** FS handler 对每次路径访问同时执行 workspace 边界与符号链接检查。 */
const fsHandlers = {
  'fs/readFile': async (context, params) => {
    const target = await existingPathInside(params.cwd, params.path);
    const info = await lstat(target);
    if (!info.isFile()) {
      throw invalidParams(`Path is not a regular file: ${target}.`);
    }
    if (info.size > MAX_FILE_BYTES) {
      throw invalidParams(
        `File exceeds the ${MAX_FILE_BYTES} byte read limit.`,
      );
    }
    const contentBytes = await readFile(target);
    if (contentBytes.byteLength > MAX_FILE_BYTES) {
      throw invalidParams(
        `File exceeds the ${MAX_FILE_BYTES} byte read limit.`,
      );
    }
    const content = decodeUtf8(contentBytes, target);
    const byteCount = contentBytes.byteLength;
    const maxBytes = params.maxBytes ?? INLINE_ARTIFACT_BYTES;
    if (byteCount <= maxBytes) {
      return { path: target, content, byteCount, truncated: false };
    }
    const artifact = await context.artifacts.put({
      kind: 'file-read',
      content: contentBytes,
      contentType: 'text/plain',
      owner: {
        kind: 'tool-result',
        id: createEntityId('job'),
        relation: target,
      },
    });
    return {
      path: target,
      content: utf8Prefix(content, maxBytes),
      byteCount,
      truncated: true,
      artifactId: artifact.id,
    };
  },
  'fs/readDirectory': async (_context, params) => {
    const directory = await existingPathInside(params.cwd, params.path);
    const entries = await readdir(directory, { withFileTypes: true });
    return {
      data: entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => ({
          name: entry.name,
          path: path.join(directory, entry.name),
          kind: entry.isSymbolicLink()
            ? ('symlink' as const)
            : entry.isDirectory()
              ? ('directory' as const)
              : ('file' as const),
        })),
    };
  },
  'fs/getMetadata': async (_context, params) => {
    const target = lexicalPathInside(params.cwd, params.path);
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      await existingPathInside(params.cwd, params.path);
    }
    return fileMetadata(target, info);
  },
  'fs/search': async (_context, params) => {
    const root = await existingPathInside(params.cwd, '.');
    const query = params.query.toLocaleLowerCase();
    const results: Array<{
      name: string;
      path: string;
      kind: 'file' | 'directory' | 'symlink';
    }> = [];
    const pending = [root];
    while (pending.length > 0 && results.length < params.limit) {
      const directory = pending.shift();
      if (directory === undefined) {
        throw new Error('Filesystem search queue became inconsistent.');
      }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const target = path.join(directory, entry.name);
        const kind = entry.isSymbolicLink()
          ? ('symlink' as const)
          : entry.isDirectory()
            ? ('directory' as const)
            : ('file' as const);
        if (entry.isDirectory()) pending.push(target);
        const matchesKind =
          params.kind === 'any' ||
          (params.kind === 'directory' && kind === 'directory') ||
          (params.kind === 'file' && kind === 'file');
        if (matchesKind && entry.name.toLocaleLowerCase().includes(query)) {
          results.push({ name: entry.name, path: target, kind });
          if (results.length >= params.limit) break;
        }
      }
    }
    return { data: results };
  },
  'fs/watch': async (context, params) => {
    const targets = await Promise.all(
      params.paths.map((target) => existingPathInside(params.cwd, target)),
    );
    const watchId = createEntityId('watch');
    const watchers = targets.map((target) =>
      watch(target, (event, fileName) => {
        const changedPath =
          fileName === null ? target : path.join(target, fileName.toString());
        void context.peer
          .notify({
            method: 'fs/changed',
            params: {
              watchId,
              path: changedPath,
              event,
            },
          })
          .catch(() => {
            // 连接过载或断开后 watcher 仍可能收到一个已排队的文件事件，需释放其资源。
            const owned = context.watchers.get(watchId);
            if (
              owned === undefined ||
              owned.connectionId !== context.peer.connectionId
            ) {
              return;
            }
            owned.watcher.close();
            context.watchers.delete(watchId);
          });
      }),
    );
    context.watchers.set(watchId, {
      connectionId: context.peer.connectionId,
      watcher: {
        close: () => {
          for (const watcher of watchers) watcher.close();
        },
      },
    });
    return { watchId };
  },
  'fs/unwatch': (context, params) => {
    const owned = context.watchers.get(params.watchId);
    if (
      owned === undefined ||
      owned.connectionId !== context.peer.connectionId
    ) {
      throw invalidParams(`Unknown watch ${params.watchId}.`);
    }
    owned.watcher.close();
    context.watchers.delete(params.watchId);
    return { ok: true };
  },
} satisfies FeatureHandlerMap<FsContext, FsMethod>;

function fileMetadata(target: string, info: Awaited<ReturnType<typeof lstat>>) {
  const size = Number(info.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`File size is outside the protocol range: ${target}.`);
  }
  return {
    path: target,
    kind: info.isSymbolicLink()
      ? ('symlink' as const)
      : info.isDirectory()
        ? ('directory' as const)
        : ('file' as const),
    size,
    modifiedAt: info.mtime.toISOString(),
  };
}

function utf8Prefix(value: string, maxBytes: number): string {
  const content = Buffer.from(value, 'utf8');
  if (content.byteLength <= maxBytes) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = maxBytes; end > 0; end -= 1) {
    try {
      return decoder.decode(content.subarray(0, end));
    } catch {
      // UTF-8 code point 最多四字节，向前收缩直到落在完整字符边界。
    }
  }
  throw new Error('Unable to find a complete UTF-8 prefix.');
}

function decodeUtf8(content: Buffer, target: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw invalidParams(`File is not valid UTF-8 text: ${target}.`);
  }
}

/**
 * 构造 文件系统 route 适配 模块 中的 `createFsRoutes` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `input`: `createFsRoutes` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `createFsRoutes` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 文件系统 route 适配 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createFsRoutes(input: {
  readonly artifacts: ArtifactStore;
  readonly watchers: FsWatchers;
}): RpcRouteFragment<FsMethod> {
  const bind = <M extends FsMethod>(method: M) =>
    bindFeatureRoute(fsHandlers, (peer) => ({ ...input, peer }), method);
  return {
    'fs/readFile': bind('fs/readFile'),
    'fs/readDirectory': bind('fs/readDirectory'),
    'fs/getMetadata': bind('fs/getMetadata'),
    'fs/search': bind('fs/search'),
    'fs/watch': bind('fs/watch'),
    'fs/unwatch': bind('fs/unwatch'),
  };
}
