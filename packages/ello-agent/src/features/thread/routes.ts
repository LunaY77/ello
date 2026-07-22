/**
 * Thread 与 Turn 的 typed RPC route adapter。
 *
 * 所有 Thread/Turn client methods 在协议参数解析后直接调用 Thread feature；本文件只处理 connection
 * listener、分页、Plan artifact 校验、shell 输出协议和 artifact 内联上限，不拥有 Thread 状态。
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { createEntityId } from '../../ids.js';
import { invalidParams } from '../../protocol/errors.js';
import { isRecord } from '../../protocol/json-value.js';
import {
  AppServerError,
  type PendingServerRequest,
} from '../../protocol/v1/index.js';
import {
  bindFeatureRoute,
  type FeatureHandlerMap,
  RpcPeerUnavailableError,
} from '../../server/rpc/route.js';
import { page } from '../../server/rpc/route.js';
import {
  route,
  type RpcPeer,
  type RpcRouteFragment,
} from '../../server/rpc/route.js';
import type { ArtifactStore } from '../artifact/index.js';

import { readPlanArtifact } from './plan.js';
import { ServerRequestControllerUnavailableError } from './state.js';

import type { ThreadFeature } from './index.js';

const execAsync = promisify(exec);
const INLINE_ARTIFACT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

type CoreThreadMethod =
  | 'thread/start'
  | 'thread/resume'
  | 'thread/read'
  | 'thread/list'
  | 'thread/loaded/list'
  | 'thread/fork'
  | 'thread/unsubscribe'
  | 'thread/archive'
  | 'thread/unarchive'
  | 'thread/delete'
  | 'thread/turns/list'
  | 'thread/items/list'
  | 'thread/settings/update'
  | 'turn/start'
  | 'turn/steer'
  | 'turn/interrupt';

type ThreadOperationMethod =
  | 'thread/compact/start'
  | 'thread/shellCommand'
  | 'thread/goal/get'
  | 'thread/goal/set'
  | 'thread/goal/clear'
  | 'thread/plan/read'
  | 'thread/plan/preview';

type ThreadMethod = CoreThreadMethod | ThreadOperationMethod;

export interface ThreadRouteContext {
  readonly artifacts: ArtifactStore;
  /**
   * 在 Thread route 适配 模块 中执行 `compact` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 Thread route 适配 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  readonly compact: (threadId: string) => Promise<unknown | null>;
  readonly threads: ThreadFeature;
}

const operationHandlers = {
  'thread/compact/start': async (context, params) => {
    const report = await context.compact(params.threadId);
    if (report === null) {
      throw invalidParams('Thread has no compactable history.');
    }
    return { jobId: createEntityId('job') };
  },
  'thread/shellCommand': async (context, params) => {
    const snapshot = await context.threads.read({
      threadId: params.threadId,
      includeTurns: false,
      includeItems: false,
    });
    if (snapshot.settings.mode === 'plan') {
      throw new AppServerError({
        type: 'permissionDenied',
        message: 'Shell commands are disabled in Plan mode.',
      });
    }
    const started = Date.now();
    let exitCode = 0;
    let stdout: string;
    let stderr: string;
    try {
      const result = await execAsync(params.command, {
        cwd: snapshot.thread.cwd,
        timeout: params.timeoutMs ?? 30_000,
        maxBuffer: MAX_FILE_BYTES,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const failure = isRecord(error) ? error : {};
      exitCode =
        failure.killed === true
          ? -1
          : typeof failure.code === 'number'
            ? failure.code
            : 1;
      stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
      stderr =
        failure.killed === true
          ? 'timeout'
          : typeof failure.stderr === 'string'
            ? failure.stderr
            : error instanceof Error
              ? error.message
              : 'Shell command failed.';
    }
    const fullOutput = `${stdout}${stderr}`;
    const response = {
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
    };
    if (Buffer.byteLength(fullOutput) <= INLINE_ARTIFACT_BYTES) return response;
    const artifact = await context.artifacts.put({
      kind: 'shell-output',
      content: fullOutput,
      contentType: 'text/plain',
      owner: {
        kind: 'tool-result',
        id: createEntityId('job'),
        relation: params.threadId,
      },
    });
    return {
      ...response,
      stdout: utf8Prefix(stdout, INLINE_ARTIFACT_BYTES / 2),
      stderr: utf8Prefix(stderr, INLINE_ARTIFACT_BYTES / 2),
      artifactId: artifact.id,
    };
  },
  'thread/goal/get': async (context, params) => ({
    goal: await context.threads.goal(params.threadId),
  }),
  'thread/goal/set': async (context, params) => ({
    goal: await context.threads.setGoal(params.threadId, {
      objective: params.objective,
      ...(params.tokenBudget === undefined
        ? {}
        : { tokenBudget: params.tokenBudget }),
      ...(params.status === undefined ? {} : { status: params.status }),
    }),
  }),
  'thread/goal/clear': async (context, params) => ({
    goalId: await context.threads.clearGoal(params.threadId),
  }),
  'thread/plan/read': async (context, params) => ({
    plan: await context.threads.plan(params.threadId),
  }),
  'thread/plan/preview': async (context, params) => {
    const snapshot = await context.threads.read({
      threadId: params.threadId,
      includeTurns: false,
      includeItems: false,
    });
    const snapshotPlan = snapshot.plan;
    if (snapshotPlan === null) {
      throw invalidParams(`Thread ${params.threadId} has no plan.`);
    }
    const artifact = await readPlanArtifact(
      snapshot.thread.cwd,
      params.threadId,
    );
    if (
      params.contentHash !== snapshotPlan.contentHash ||
      artifact.contentHash !== snapshotPlan.contentHash
    ) {
      throw invalidParams('Plan content hash is stale.');
    }
    return { plan: { ...snapshotPlan, content: artifact.content } };
  },
} satisfies FeatureHandlerMap<ThreadRouteContext, ThreadOperationMethod>;

/**
 * 创建全部 Thread 与 Turn typed routes。
 *
 * Args:
 * - `context.artifacts`: 大型 shell 输出使用的 artifact store。
 * - `context.compact`: 手动压缩当前 Thread 的函数。
 * - `context.threads`: 所有 route 调用的唯一 Thread feature。
 *
 * Returns:
 * - 返回覆盖全部 Thread/Turn client methods 的 route fragment。
 */
export function createThreadRoutes(
  context: ThreadRouteContext,
): RpcRouteFragment<ThreadMethod> {
  const bind = <TMethod extends ThreadOperationMethod>(method: TMethod) =>
    bindFeatureRoute(operationHandlers, () => context, method);
  return {
    'thread/start': route('write', async (peer, params) => {
      const attachment = await context.threads.start(
        peer.connectionId,
        params,
        params.subscribe
          ? (notification) => peer.notify(notification)
          : undefined,
        serverRequestListener(peer),
      );
      return attachment.snapshot;
    }),
    'thread/resume': route('write', async (peer, params) => {
      const attachment = await context.threads.resume(
        peer.connectionId,
        params,
        params.subscribe
          ? (notification) => peer.notify(notification)
          : undefined,
        serverRequestListener(peer),
      );
      return attachment.snapshot;
    }),
    'thread/read': route('read', (_peer, params) =>
      context.threads.read(params),
    ),
    'thread/list': route('read', (_peer, params) =>
      context.threads.list(params),
    ),
    'thread/loaded/list': route('read', async () => ({
      data: await context.threads.loaded(),
    })),
    'thread/fork': route('write', async (peer, params) => {
      const attachment = await context.threads.fork(
        peer.connectionId,
        params,
        params.subscribe
          ? (notification) => peer.notify(notification)
          : undefined,
        serverRequestListener(peer),
      );
      return attachment.snapshot;
    }),
    'thread/unsubscribe': route('write', async (peer, params) => {
      await context.threads.unsubscribe(peer.connectionId, params.threadId);
      return { ok: true };
    }),
    'thread/archive': route('write', async (_peer, params) => ({
      thread: await context.threads.archive(params.threadId),
    })),
    'thread/unarchive': route('write', async (_peer, params) => ({
      thread: await context.threads.unarchive(params.threadId),
    })),
    'thread/delete': route('write', async (_peer, params) => {
      await context.threads.delete(params.threadId);
      return { ok: true };
    }),
    'thread/turns/list': route('read', async (_peer, params) => {
      const snapshot = await context.threads.read({
        threadId: params.threadId,
        includeTurns: true,
        includeItems: false,
      });
      return page(snapshot.turns, params.cursor, params.limit);
    }),
    'thread/items/list': route('read', async (_peer, params) => {
      const snapshot = await context.threads.read({
        threadId: params.threadId,
        includeTurns: true,
        includeItems: true,
      });
      const items = snapshot.turns
        .filter(
          (turn) => params.turnId === undefined || turn.id === params.turnId,
        )
        .flatMap((turn) => turn.items);
      return page(items, params.cursor, params.limit);
    }),
    'thread/settings/update': route('write', (peer, params) =>
      context.threads.updateSettings(peer.connectionId, params),
    ),
    'turn/start': route('submit', async (_peer, params) => ({
      turn: await context.threads.startTurn(params.threadId, params.input, {
        ...(params.model === undefined ? {} : { model: params.model }),
        ...(params.profile === undefined ? {} : { profile: params.profile }),
        ...(params.mode === undefined ? {} : { mode: params.mode }),
      }),
    })),
    'turn/steer': route('submit', async (_peer, params) => {
      await context.threads.steerTurn(
        params.threadId,
        params.expectedTurnId,
        params.input,
      );
      return { ok: true };
    }),
    'turn/interrupt': route('submit', async (_peer, params) => ({
      turn: await context.threads.interruptTurn(
        params.threadId,
        params.turnId,
        params.reason,
      ),
    })),
    'thread/compact/start': bind('thread/compact/start'),
    'thread/shellCommand': bind('thread/shellCommand'),
    'thread/goal/get': bind('thread/goal/get'),
    'thread/goal/set': bind('thread/goal/set'),
    'thread/goal/clear': bind('thread/goal/clear'),
    'thread/plan/read': bind('thread/plan/read'),
    'thread/plan/preview': bind('thread/plan/preview'),
  } satisfies RpcRouteFragment<ThreadMethod>;
}

function serverRequestListener(
  peer: RpcPeer,
): ((request: PendingServerRequest) => Promise<unknown>) | undefined {
  if (!peer.supportsServerRequests) return undefined;
  return async (request) => {
    try {
      return await peer.request(request);
    } catch (error) {
      if (error instanceof RpcPeerUnavailableError) {
        throw new ServerRequestControllerUnavailableError(error);
      }
      throw error;
    }
  };
}

function utf8Prefix(value: string, maxBytes: number): string {
  const content = Buffer.from(value, 'utf8');
  if (content.byteLength <= maxBytes) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = maxBytes; end > 0; end -= 1) {
    try {
      return decoder.decode(content.subarray(0, end));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  throw new Error('Unable to find a complete UTF-8 prefix.');
}
