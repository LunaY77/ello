export type ToolRisk = 'readonly' | 'workspace-write' | 'external';

export interface ToolMetadata {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
}

export const codingToolRegistry = [
  {
    name: 'read',
    description: 'read file with line numbers',
    risk: 'readonly',
  },
  { name: 'ls', description: 'list directory', risk: 'readonly' },
  { name: 'grep', description: 'search file contents', risk: 'readonly' },
  { name: 'glob', description: 'match file paths', risk: 'readonly' },
  {
    name: 'write',
    description: 'create or overwrite file',
    risk: 'workspace-write',
  },
  {
    name: 'edit',
    description: 'unique text replacement',
    risk: 'workspace-write',
  },
  { name: 'bash', description: 'run shell command', risk: 'external' },
  {
    name: 'task_create',
    description: 'create persisted task',
    risk: 'workspace-write',
  },
  { name: 'task_list', description: 'list persisted tasks', risk: 'readonly' },
  { name: 'task_get', description: 'get persisted task', risk: 'readonly' },
  {
    name: 'task_update',
    description: 'update persisted task',
    risk: 'workspace-write',
  },
  {
    name: 'task_delete',
    description: 'delete persisted task',
    risk: 'workspace-write',
  },
  {
    name: 'task_claim',
    description: 'claim persisted task',
    risk: 'workspace-write',
  },
  {
    name: 'task_reset',
    description: 'reset current task list',
    risk: 'workspace-write',
  },
  {
    name: 'workspace_repo_list',
    description: 'list registered repos',
    risk: 'readonly',
  },
  {
    name: 'workspace_repo_show',
    description: 'show one registered repo',
    risk: 'readonly',
  },
  {
    name: 'workspace_repo_add',
    description: 'add repo mirror',
    risk: 'external',
  },
  {
    name: 'workspace_repo_sync',
    description: 'sync repo mirrors',
    risk: 'external',
  },
  {
    name: 'workspace_repo_remove',
    description: 'remove repo mirror',
    risk: 'workspace-write',
  },
  {
    name: 'workspace_repo_rename',
    description: 'rename repo key',
    risk: 'workspace-write',
  },
  {
    name: 'workspace_repo_set_url',
    description: 'change repo URL',
    risk: 'workspace-write',
  },
  {
    name: 'workspace_create',
    description: 'create workspace',
    risk: 'external',
  },
  {
    name: 'workspace_add_repos',
    description: 'add repos to workspace',
    risk: 'external',
  },
  {
    name: 'workspace_remove_repos',
    description: 'remove repos from workspace',
    risk: 'workspace-write',
  },
  {
    name: 'workspace_rename',
    description: 'rename workspace',
    risk: 'workspace-write',
  },
  { name: 'workspace_list', description: 'list workspaces', risk: 'readonly' },
  { name: 'workspace_open', description: 'open workspace', risk: 'readonly' },
  {
    name: 'workspace_archive',
    description: 'archive workspace',
    risk: 'workspace-write',
  },
  {
    name: 'workspace_remove',
    description: 'remove workspace',
    risk: 'workspace-write',
  },
  {
    name: 'workspace_status',
    description: 'show workspace status',
    risk: 'readonly',
  },
  {
    name: 'workspace_sync',
    description: 'sync workspace state',
    risk: 'external',
  },
  { name: 'web_fetch', description: 'fetch URL', risk: 'external' },
  {
    name: 'tool_search',
    description: 'search available tools',
    risk: 'readonly',
  },
] as const satisfies readonly ToolMetadata[];

const metadataByName: ReadonlyMap<string, ToolMetadata> = new Map(
  codingToolRegistry.map((metadata) => [metadata.name, metadata]),
);

export function toolMetadata(name: string): ToolMetadata | undefined {
  return metadataByName.get(name);
}

export function isReadOnlyTool(name: string): boolean {
  return toolMetadata(name)?.risk === 'readonly';
}

export function formatToolRegistry(): string {
  return codingToolRegistry
    .filter((tool) => tool.name !== 'tool_search')
    .map((tool) => `${tool.name}\t${tool.description}`)
    .join('\n');
}
