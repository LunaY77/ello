import { readFile } from 'node:fs/promises';
import type { Writable } from 'node:stream';

import { createProductionThreadCompactor } from '../agent/context/thread-compactor.js';
import { createAgentTurnExecutorFactory } from '../agent/execution/agent-turn-executor.js';
import { createThreadTitleGenerator } from '../agent/execution/thread-title-generator.js';
import { createProviderRegistry } from '../agent/providers/catalog/index.js';
import { loadCodingAgentConfig } from '../config/index.js';
import {
  AppServerError,
  type ParsedClientParams,
  type ThreadSnapshot,
} from '../protocol/v1/index.js';
import { createCodingStorage } from '../storage/database/index.js';
import {
  artifactsDir,
  elloHomeDir,
  legacyStateDatabasePath,
  stateDatabasePath,
} from '../storage/paths.js';
import { ThreadLogRepository } from '../storage/threads/thread-log.js';

import { ServerServices } from './methods/server-services.js';
import { ThreadManager } from './runtime/thread-manager.js';
import { AgentServer } from './server.js';

export interface BootstrapAgentServerOptions {
  readonly root?: string;
  readonly stderr?: Writable;
  readonly transports: readonly ('stdio' | 'websocket' | 'unix')[];
}

/** 所有跨顶层模块的具体实现只在这里组装。 */
export async function bootstrapAgentServer(
  options: BootstrapAgentServerOptions,
): Promise<AgentServer> {
  const root = options.root ?? elloHomeDir();
  const logs = new ThreadLogRepository({ root });
  const storage = createCodingStorage({
    databasePath: stateDatabasePath(root),
    artifactsDir: artifactsDir(root),
    legacyDatabasePath: legacyStateDatabasePath(root),
  });
  const threads = new ThreadManager({
    root,
    logs,
    catalog: storage.threads,
    executorFactory: createAgentTurnExecutorFactory({ logs, storage }),
    titleGenerator: createThreadTitleGenerator({ logs }),
    resolveInitialSettings,
    resolveSettingsUpdate,
  });
  const services = new ServerServices({
    threads,
    logs,
    storage,
    compactThread: async (threadId) => {
      const snapshot = await threads.read({
        threadId,
        includeTurns: true,
        includeItems: true,
      });
      if (snapshot.thread.status === 'running') {
        throw new AppServerError({
          type: 'threadBusy',
          message: `Thread ${threadId} is running; interrupt it before compacting.`,
        });
      }
      const compactor = await createProductionThreadCompactor({
        logs,
        snapshot,
      });
      return compactor.compactNow(threadId, {
        force: true,
        ...(snapshot.turns.at(-1)?.id === undefined
          ? {}
          : { turnId: snapshot.turns.at(-1)!.id }),
      });
    },
  });
  return new AgentServer({
    version: await packageVersion(),
    threads,
    transports: options.transports,
    services,
    ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
    closeResources: () => storage.close(),
  });
}

async function resolveInitialSettings(
  params: ParsedClientParams<'thread/start'>,
) {
  const config = await loadCodingAgentConfig({ cwd: params.cwd });
  const profile = params.profile ?? config.active_profile;
  const mode = params.mode ?? config.initial_mode;
  if (mode === 'bypass' && !config.bypass_enabled) {
    throw new AppServerError({
      type: 'permissionDenied',
      message: 'Bypass mode requires bypass_enabled: true.',
    });
  }
  return {
    mode,
    profile,
    model:
      params.model ??
      createProviderRegistry(config).resolveRole(profile, 'primary').ref,
    agent: params.agent ?? config.default_agent,
  };
}

async function resolveSettingsUpdate(
  snapshot: ThreadSnapshot,
  params: Omit<ParsedClientParams<'thread/settings/update'>, 'threadId'>,
) {
  const config = await loadCodingAgentConfig({ cwd: snapshot.thread.cwd });
  if (params.mode === 'bypass' && !config.bypass_enabled) {
    throw new AppServerError({
      type: 'permissionDenied',
      message: 'Bypass mode requires bypass_enabled: true.',
    });
  }
  return {
    ...(params.mode === undefined ? {} : { mode: params.mode }),
    ...(params.profile === undefined ? {} : { profile: params.profile }),
    ...(params.model !== undefined
      ? { model: params.model }
      : params.profile === undefined
        ? {}
        : {
            model: createProviderRegistry(config).resolveRole(
              params.profile,
              'primary',
            ).ref,
          }),
    ...(params.agent === undefined ? {} : { agent: params.agent }),
  };
}

async function packageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { readonly version?: unknown };
  if (typeof packageJson.version !== 'string' || packageJson.version === '') {
    throw new Error('@ello/agent package.json has no version.');
  }
  return packageJson.version;
}
