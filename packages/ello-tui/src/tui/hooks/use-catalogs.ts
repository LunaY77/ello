import { useEffect, useState } from 'react';

import type {
  AgentCatalogEntry,
  AgentSkill,
  CatalogEntry,
  Task,
} from '../../api/protocol-types.js';
import { ThreadClient } from '../../client/thread-client.js';

/** 统一加载 Server catalog，避免 ThreadScreen 持有七组远程数据 effect。 */
export interface CatalogData {
  readonly models: readonly CatalogEntry[];
  readonly skills: readonly AgentSkill[];
  readonly agents: readonly AgentCatalogEntry[];
  readonly tasks: readonly Task[];
  readonly config: unknown;
}

type CatalogState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly error: unknown }
  | ({ readonly status: 'ready' } & CatalogData);

export type CatalogLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly error: unknown }
  | ({ readonly status: 'ready' } & CatalogData & {
        setConfig(config: unknown): void;
      });

export async function loadCatalogs(thread: ThreadClient): Promise<CatalogData> {
  const [models, skills, agents, tasks, config] = await Promise.all([
    thread.request('model/list', { cwd: thread.cwd }),
    thread.request('skills/list', {
      cwd: thread.cwd,
      threadId: thread.threadId,
    }),
    thread.request('agent/list', {
      cwd: thread.cwd,
      threadId: thread.threadId,
    }),
    thread.request('task/list', { limit: 50 }),
    thread.request('config/read', { cwd: thread.cwd, includeSources: false }),
  ]);
  return {
    models: models.data,
    skills: skills.data,
    agents: agents.data,
    tasks: tasks.data,
    config: config.config,
  };
}

export function useCatalogs(thread: ThreadClient): CatalogLoadState {
  const [state, setState] = useState<CatalogState>({ status: 'loading' });
  useEffect(() => {
    void loadCatalogs(thread)
      .then((catalogs) => setState({ status: 'ready', ...catalogs }))
      .catch((error: unknown) => setState({ status: 'failed', error }));
  }, [thread]);
  if (state.status !== 'ready') return state;
  return {
    ...state,
    setConfig: (config) =>
      setState((current) => {
        if (current.status !== 'ready') {
          throw new Error('Cannot update config before catalogs are ready.');
        }
        return { ...current, config };
      }),
  };
}
