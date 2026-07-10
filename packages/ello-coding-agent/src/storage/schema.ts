import { sql } from 'drizzle-orm';
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

/** 轻量元信息：迁移/import 标记、价格表版本、报表缓存版本等。 */
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 大对象制品元数据；真实内容放在 `~/.ello/artifacts/`。 */
export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  path: text('path').notNull(),
  sha256: text('sha256').notNull(),
  byteSize: integer('byte_size').notNull(),
  contentType: text('content_type'),
  createdAt: text('created_at').notNull(),
});

/** 全局 repo registry 的结构化镜像，供 workspace 关联和查询使用。 */
export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  sourceUrl: text('source_url'),
  mirrorPath: text('mirror_path'),
  defaultBranch: text('default_branch'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** workspace 是全局产品抽象，DB 是唯一事实源，不再写 workspace manifest。 */
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  rootPath: text('root_path').notNull(),
  status: text('status').notNull(),
  branch: text('branch'),
  tmuxSession: text('tmux_session'),
  lastSyncedAt: text('last_synced_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** workspace 与 repo 的 worktree 关系；不把 usage/tasks/checkpoint 挂到这里。 */
export const workspaceRepositories = sqliteTable(
  'workspace_repositories',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id),
    checkoutPath: text('checkout_path').notNull(),
    branch: text('branch'),
    status: text('status').notNull(),
    lastGitStatus: text('last_git_status'),
    lastSyncedAt: text('last_synced_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.repositoryId] })],
);

/** 显式 sync 的执行记录；sync 只校验/标记漂移，不隐式改真实 worktree。 */
export const workspaceSyncRuns = sqliteTable('workspace_sync_runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').references(() => workspaces.id),
  status: text('status').notNull(),
  checkedCount: integer('checked_count').notNull(),
  fixedCount: integer('fixed_count').notNull(),
  errorMessage: text('error_message'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
});

/** 安全 usage 聚合记录：只存 token/模型/状态，不存 prompt、工具入参或输出。 */
export const usageRecords = sqliteTable('usage_records', {
  id: text('id').primaryKey(),
  runId: text('run_id'),
  invocation: text('invocation').notNull(),
  provider: text('provider'),
  model: text('model').notNull(),
  status: text('status').notNull(),
  finishReason: text('finish_reason'),
  requests: integer('requests').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  cacheReadTokens: integer('cache_read_tokens').notNull(),
  cacheWriteTokens: integer('cache_write_tokens').notNull(),
  toolCalls: integer('tool_calls').notNull(),
  estimatedCostUsd: real('estimated_cost_usd'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
});

/** 模型价格快照；估算成本只基于快照，不声明为精确账单。 */
export const usagePriceSnapshots = sqliteTable('usage_price_snapshots', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputUsdPer1m: real('input_usd_per_1m'),
  outputUsdPer1m: real('output_usd_per_1m'),
  cacheReadUsdPer1m: real('cache_read_usd_per_1m'),
  cacheWriteUsdPer1m: real('cache_write_usd_per_1m'),
  source: text('source'),
  effectiveAt: text('effective_at').notNull(),
  createdAt: text('created_at').notNull(),
});

/** usage 报表缓存，后续 TUI/CLI 报表可以按 key 复用。 */
export const usageReportCache = sqliteTable('usage_report_cache', {
  id: text('id').primaryKey(),
  reportKey: text('report_key').notNull(),
  paramsJson: text('params_json').notNull(),
  resultJson: text('result_json').notNull(),
  generatedAt: text('generated_at').notNull(),
});

/** checkpoint 元数据；不挂 session/workspace 外键，runId 只是弱关联字符串。 */
export const checkpoints = sqliteTable('checkpoints', {
  id: text('id').primaryKey(),
  runId: text('run_id'),
  label: text('label'),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  rolledBackAt: text('rolled_back_at'),
});

/** checkpoint 文件变化；文件内容通过 artifact 关联，不直接塞进 DB。 */
export const checkpointFileChanges = sqliteTable('checkpoint_file_changes', {
  id: text('id').primaryKey(),
  checkpointId: text('checkpoint_id')
    .notNull()
    .references(() => checkpoints.id),
  path: text('path').notNull(),
  pathHash: text('path_hash').notNull(),
  changeType: text('change_type').notNull(),
  beforeArtifactId: text('before_artifact_id').references(() => artifacts.id),
  afterArtifactId: text('after_artifact_id').references(() => artifacts.id),
  beforeSha256: text('before_sha256'),
  afterSha256: text('after_sha256'),
  diff: text('diff'),
  toolCallId: text('tool_call_id'),
  createdAt: text('created_at').notNull(),
});

/** 回滚记录；回滚仍由调用方按权限策略放行，本表只负责审计结果。 */
export const checkpointRollbacks = sqliteTable('checkpoint_rollbacks', {
  id: text('id').primaryKey(),
  checkpointId: text('checkpoint_id')
    .notNull()
    .references(() => checkpoints.id),
  runId: text('run_id'),
  status: text('status').notNull(),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
});

/** 显式 task board；scope 决定任务属于 session、workspace 或命名 global board。 */
export const taskBoards = sqliteTable('task_boards', {
  id: text('id').primaryKey(),
  scopeType: text('scope_type').notNull(),
  scopeId: text('scope_id').notNull(),
  nextSequence: integer('next_sequence').notNull(),
  createdAt: text('created_at').notNull(),
  archivedAt: text('archived_at'),
});

/** board 内任务使用 UUID 主键和独立递增 sequence。 */
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  boardId: text('board_id')
    .notNull()
    .references(() => taskBoards.id),
  sequence: integer('sequence').notNull(),
  subject: text('subject').notNull(),
  description: text('description').notNull(),
  activeForm: text('active_form'),
  status: text('status').notNull(),
  owner: text('owner'),
  metadata: text('metadata').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 单向 dependency：blocker_task_id 阻塞 blocked_task_id。 */
export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    boardId: text('board_id')
      .notNull()
      .references(() => taskBoards.id),
    blockerTaskId: text('blocker_task_id')
      .notNull()
      .references(() => tasks.id),
    blockedTaskId: text('blocked_task_id')
      .notNull()
      .references(() => tasks.id),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.boardId, table.blockerTaskId, table.blockedTaskId],
    }),
  ],
);

/** 全局结构化 memory；项目 memory Markdown 不进入本表，也不建索引缓存。 */
export const memoryItems = sqliteTable('memory_items', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  content: text('content').notNull(),
  tags: text('tags').notNull().default('[]'),
  source: text('source').notNull(),
  confidence: real('confidence'),
  enabled: integer('enabled').notNull().default(1),
  lastUsedAt: text('last_used_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  archivedAt: text('archived_at'),
});

/** memory 使用记录；用于后续清理、排序和“为什么注入了这条记忆”的解释。 */
export const memoryAccessLog = sqliteTable('memory_access_log', {
  id: text('id').primaryKey(),
  memoryItemId: text('memory_item_id')
    .notNull()
    .references(() => memoryItems.id),
  runId: text('run_id'),
  usedFor: text('used_for').notNull(),
  createdAt: text('created_at').notNull(),
});

/** Drizzle 查询使用的 schema 对象。 */
export const codingStorageSchema = {
  meta,
  artifacts,
  repositories,
  workspaces,
  workspaceRepositories,
  workspaceSyncRuns,
  usageRecords,
  usagePriceSnapshots,
  usageReportCache,
  checkpoints,
  checkpointFileChanges,
  checkpointRollbacks,
  taskBoards,
  tasks,
  taskDependencies,
  memoryItems,
  memoryAccessLog,
};

/** SQLite 中常用的当前时间表达式，只用于少量原子 upsert。 */
export const currentTimestamp = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
