import { defineTool, type AnyAgentTool } from '@ello/agent';
import { z } from 'zod';

import { RepoStore, WorkspaceStore } from '../workspace/index.js';

import type { ApprovalFor } from './shared.js';

/** workspace/repo 结构化工具，避免模型手拼 git worktree 命令。 */
export function createWorkspaceTools(approval: ApprovalFor): AnyAgentTool[] {
  const repos = new RepoStore();
  const workspaces = new WorkspaceStore(repos);
  return [
    defineTool({
      name: 'workspace_repo_list',
      description: 'List registered repo mirrors.',
      input: z.object({}),
      approval: approval('workspace_repo_list'),
      execute: () => repos.list(),
    }),
    defineTool({
      name: 'workspace_repo_show',
      description: 'Show one registered repo mirror.',
      input: z.object({ key: z.string() }),
      approval: approval('workspace_repo_show'),
      execute: async ({ key }) => {
        const repo = await repos.show(key);
        if (repo === null) {
          throw new Error(`Unknown repo: ${key}`);
        }
        return repo;
      },
    }),
    defineTool({
      name: 'workspace_repo_add',
      description: 'Add a repo mirror to the ello repo registry.',
      input: z.object({ key: z.string(), url: z.string() }),
      approval: approval('workspace_repo_add'),
      execute: ({ key, url }) => repos.add(key, url),
    }),
    defineTool({
      name: 'workspace_repo_sync',
      description: 'Fetch one or more repo mirrors.',
      input: z.object({ keys: z.array(z.string()).optional() }),
      approval: approval('workspace_repo_sync'),
      execute: ({ keys }) => repos.sync(keys),
    }),
    defineTool({
      name: 'workspace_repo_remove',
      description: 'Remove a repo mirror from registry and disk.',
      input: z.object({ key: z.string() }),
      approval: approval('workspace_repo_remove'),
      execute: async ({ key }) => ({ key, removed: await repos.remove(key) }),
    }),
    defineTool({
      name: 'workspace_repo_rename',
      description: 'Rename a repo registry key.',
      input: z.object({ key: z.string(), newKey: z.string() }),
      approval: approval('workspace_repo_rename'),
      execute: ({ key, newKey }) => repos.rename(key, newKey),
    }),
    defineTool({
      name: 'workspace_repo_set_url',
      description: 'Change a repo mirror origin URL.',
      input: z.object({ key: z.string(), url: z.string() }),
      approval: approval('workspace_repo_set_url'),
      execute: ({ key, url }) => repos.setUrl(key, url),
    }),
    defineTool({
      name: 'workspace_create',
      description: 'Create a feature/fix/explore workspace.',
      input: z.object({
        kind: z.enum(['feature', 'fix', 'explore']),
        name: z.string(),
        repos: z.array(z.string()),
      }),
      approval: approval('workspace_create'),
      execute: ({ kind, name, repos: repoKeys }) =>
        workspaces.create(kind, name, repoKeys),
    }),
    defineTool({
      name: 'workspace_add_repos',
      description: 'Add repos to an existing workspace.',
      input: z.object({
        kind: z.enum(['feature', 'fix', 'explore']),
        name: z.string(),
        repos: z.array(z.string()),
      }),
      approval: approval('workspace_add_repos'),
      execute: ({ kind, name, repos: repoKeys }) =>
        workspaces.addRepos(kind, name, repoKeys),
    }),
    defineTool({
      name: 'workspace_remove_repos',
      description: 'Remove repos from an existing workspace.',
      input: z.object({
        kind: z.enum(['feature', 'fix', 'explore']),
        name: z.string(),
        repos: z.array(z.string()),
        force: z.boolean().optional(),
      }),
      approval: approval('workspace_remove_repos'),
      execute: ({ kind, name, repos: repoKeys, force }) =>
        workspaces.removeRepos(kind, name, repoKeys, force ?? false),
    }),
    defineTool({
      name: 'workspace_rename',
      description: 'Rename an existing workspace.',
      input: z.object({
        kind: z.enum(['feature', 'fix', 'explore']),
        name: z.string(),
        newName: z.string(),
      }),
      approval: approval('workspace_rename'),
      execute: ({ kind, name, newName }) =>
        workspaces.rename(kind, name, newName),
    }),
    defineTool({
      name: 'workspace_list',
      description: 'List ello workspaces.',
      input: z.object({
        kind: z.enum(['feature', 'fix', 'explore']).optional(),
      }),
      approval: approval('workspace_list'),
      execute: ({ kind }) => workspaces.list(kind),
    }),
    defineTool({
      name: 'workspace_open',
      description: 'Open one workspace from the global SQLite registry.',
      input: z.object({
        kind: z.enum(['feature', 'fix', 'explore']),
        name: z.string(),
      }),
      approval: approval('workspace_open'),
      execute: ({ kind, name }) => workspaces.open(kind, name),
    }),
    defineTool({
      name: 'workspace_archive',
      description: 'Archive one clean workspace.',
      input: z.object({
        kind: z.enum(['feature', 'fix', 'explore']),
        name: z.string(),
      }),
      approval: approval('workspace_archive'),
      execute: ({ kind, name }) => workspaces.archive(kind, name),
    }),
    defineTool({
      name: 'workspace_remove',
      description: 'Remove one workspace and its worktrees.',
      input: z.object({
        kind: z.enum(['feature', 'fix', 'explore']),
        name: z.string(),
        force: z.boolean().optional(),
      }),
      approval: approval('workspace_remove'),
      execute: ({ kind, name, force }) =>
        workspaces.remove(kind, name, force ?? false),
    }),
    defineTool({
      name: 'workspace_status',
      description: 'Show workspace dirty status summary.',
      input: z.object({}),
      approval: approval('workspace_status'),
      execute: () => workspaces.status(),
    }),
    defineTool({
      name: 'workspace_sync',
      description:
        'Check global SQLite workspace records against filesystem/git state.',
      input: z.object({
        fixMissing: z.boolean().optional(),
        prune: z.boolean().optional(),
      }),
      approval: approval('workspace_sync'),
      execute: ({ fixMissing, prune }) =>
        workspaces.sync({
          fixMissing: fixMissing ?? false,
          prune: prune ?? false,
        }),
    }),
  ] as AnyAgentTool[];
}
