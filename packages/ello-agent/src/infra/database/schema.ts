/**
 * 本文件负责基础设施层的运行时 schema 与派生类型。
 *
 * 外部进程、数据库、文件或遥测资源由显式参数和返回值限定所有权，不保存产品会话状态。
 * 适配边界只转换已声明的协议；资源错误保持原因并向调用方传播。
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** 轻量元信息：迁移/import 标记、价格表版本、报表缓存版本等。 */
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 大对象制品元数据；真实内容放在 `~/.ello/artifacts/`。 */
export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    path: text('path').notNull(),
    sha256: text('sha256').notNull(),
    byteSize: integer('byte_size').notNull(),
    contentType: text('content_type'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('artifacts_sha256_idx').on(table.sha256)],
);

/** artifact 与产品实体之间的显式所有权引用。 */
export const artifactReferences = sqliteTable(
  'artifact_references',
  {
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    ownerKind: text('owner_kind').notNull(),
    ownerId: text('owner_id').notNull(),
    relation: text('relation').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.artifactId,
        table.ownerKind,
        table.ownerId,
        table.relation,
      ],
    }),
    index('artifact_references_owner_idx').on(table.ownerKind, table.ownerId),
  ],
);

/** 全局 repo registry 的结构化镜像，供 workspace 关联和查询使用。 */
export const repositories = sqliteTable(
  'repositories',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    remoteUrl: text('remote_url'),
    mirrorPath: text('mirror_path'),
    defaultBranch: text('default_branch'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    unique().on(table.key),
    index('repositories_remote_url_idx').on(table.remoteUrl),
  ],
);

/** workspace 是全局产品抽象，DB 是唯一事实源，不再写 workspace manifest。 */
export const workspaces = sqliteTable(
  'workspaces',
  {
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
  },
  (table) => [
    uniqueIndex('workspaces_active_selector_idx')
      .on(table.kind, table.name)
      .where(sql`${table.status} in ('active', 'missing')`),
  ],
);

/** workspace 与 repo 的 worktree 关系；不把 usage/tasks/checkpoint 挂到这里。 */
export const workspaceRepositories = sqliteTable(
  'workspace_repositories',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id),
    checkoutPath: text('checkout_path').notNull(),
    checkoutRole: text('checkout_role').notNull(),
    checkoutMode: text('checkout_mode').notNull(),
    branch: text('branch'),
    headCommit: text('head_commit'),
    status: text('status').notNull(),
    lastGitStatus: text('last_git_status'),
    lastSyncedAt: text('last_synced_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.repositoryId] })],
);

/** reconcile 执行记录；诊断只保存 observation 计数，不隐式修改 workspace。 */
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
export const usageRecords = sqliteTable(
  'usage_records',
  {
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
  },
  (table) => [
    index('usage_records_started_at_idx').on(table.startedAt),
    index('usage_records_model_idx').on(table.model),
    index('usage_records_status_idx').on(table.status),
  ],
);

/** 单次模型调用的安全 usage 与 cache fingerprint 诊断。 */
export const usageModelCalls = sqliteTable(
  'usage_model_calls',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    turnIndex: integer('turn_index').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    finishReason: text('finish_reason').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    durationMs: real('duration_ms').notNull(),
    systemFingerprint: text('system_fingerprint').notNull(),
    toolsetFingerprint: text('toolset_fingerprint').notNull(),
    messagePrefixFingerprint: text('message_prefix_fingerprint').notNull(),
    compactionBoundary: integer('compaction_boundary', {
      mode: 'boolean',
    }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('usage_model_calls_run_turn_idx').on(
      table.runId,
      table.turnIndex,
    ),
    index('usage_model_calls_run_idx').on(table.runId, table.turnIndex),
    index('usage_model_calls_created_at_idx').on(table.createdAt),
  ],
);

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

/** durable memory worker 队列；正文始终只存在于 Markdown 文件。 */
export const memoryJobs = sqliteTable(
  'memory_jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    cwd: text('cwd').notNull(),
    sessionId: text('session_id'),
    sourceLeafId: text('source_leaf_id'),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull(),
    errorMessage: text('error_message'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (table) => [
    check('memory_jobs_kind_check', sql`${table.kind} in ('extract', 'dream')`),
    check(
      'memory_jobs_status_check',
      sql`${table.status} in ('queued', 'running', 'completed', 'failed')`,
    ),
    check(
      'memory_jobs_shape_check',
      sql`(${table.kind} = 'extract' and ${table.sessionId} is not null and ${table.sourceLeafId} is not null) or (${table.kind} = 'dream' and ${table.sessionId} is null and ${table.sourceLeafId} is null)`,
    ),
    uniqueIndex('memory_jobs_extract_source_idx')
      .on(table.kind, table.cwd, table.sessionId, table.sourceLeafId)
      .where(sql`${table.kind} = 'extract'`),
    uniqueIndex('memory_jobs_active_dream_idx')
      .on(table.kind, table.cwd)
      .where(
        sql`${table.kind} = 'dream' and ${table.status} in ('queued', 'running')`,
      ),
    index('memory_jobs_status_created_idx').on(
      table.cwd,
      table.status,
      table.createdAt,
    ),
  ],
);

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
export const checkpointFileChanges = sqliteTable(
  'checkpoint_file_changes',
  {
    id: text('id').primaryKey(),
    checkpointId: text('checkpoint_id')
      .notNull()
      .references(() => checkpoints.id, { onDelete: 'cascade' }),
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
  },
  (table) => [index('checkpoint_file_changes_path_idx').on(table.pathHash)],
);

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

/** 显式 task board；scope 决定任务属于 session 或命名 global board。 */
export const taskBoards = sqliteTable(
  'task_boards',
  {
    id: text('id').primaryKey(),
    scopeType: text('scope_type').notNull(),
    scopeId: text('scope_id').notNull(),
    nextSequence: integer('next_sequence').notNull(),
    createdAt: text('created_at').notNull(),
    archivedAt: text('archived_at'),
  },
  (table) => [unique().on(table.scopeType, table.scopeId)],
);

/** board 内任务使用 UUID 主键和独立递增 sequence。 */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => taskBoards.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    subject: text('subject').notNull(),
    description: text('description').notNull(),
    activeForm: text('active_form'),
    status: text('status').notNull(),
    owner: text('owner'),
    metadata: text('metadata').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    unique().on(table.boardId, table.sequence),
    index('tasks_board_status_idx').on(table.boardId, table.status),
  ],
);

/** 单向 dependency：blocker_task_id 阻塞 blocked_task_id。 */
export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    boardId: text('board_id')
      .notNull()
      .references(() => taskBoards.id, { onDelete: 'cascade' }),
    blockerTaskId: text('blocker_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    blockedTaskId: text('blocked_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.boardId, table.blockerTaskId, table.blockedTaskId],
    }),
    check(
      'task_dependencies_no_self_check',
      sql`${table.blockerTaskId} <> ${table.blockedTaskId}`,
    ),
  ],
);

export const threadCatalog = sqliteTable(
  'thread_catalog',
  {
    id: text('id').primaryKey(),
    rootId: text('root_id').notNull(),
    forkedFromId: text('forked_from_id'),
    cwd: text('cwd').notNull(),
    name: text('name').notNull(),
    preview: text('preview').notNull(),
    status: text('status').notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    seq: integer('seq').notNull(),
  },
  (table) => [
    check('thread_catalog_archived_check', sql`${table.archived} in (0, 1)`),
    index('thread_catalog_updated_idx').on(sql`${table.updatedAt} desc`),
    index('thread_catalog_cwd_status_idx').on(
      table.cwd,
      table.status,
      table.archived,
    ),
  ],
);

export const threadTurnCatalog = sqliteTable(
  'thread_turn_catalog',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threadCatalog.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    errorCode: text('error_code'),
    usageJson: text('usage_json'),
    seq: integer('seq').notNull(),
  },
  (table) => [
    index('thread_turn_catalog_thread_seq_idx').on(table.threadId, table.seq),
  ],
);

export const threadItemCatalog = sqliteTable(
  'thread_item_catalog',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threadCatalog.id, { onDelete: 'cascade' }),
    turnId: text('turn_id')
      .notNull()
      .references(() => threadTurnCatalog.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    status: text('status'),
    createdAt: text('created_at').notNull(),
    payloadJson: text('payload_json').notNull(),
    seq: integer('seq').notNull(),
  },
  (table) => [
    index('thread_item_catalog_turn_seq_idx').on(table.turnId, table.seq),
  ],
);

export const threadRequestCatalog = sqliteTable(
  'thread_request_catalog',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threadCatalog.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').notNull(),
    itemId: text('item_id').notNull(),
    method: text('method').notNull(),
    paramsJson: text('params_json').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
    resolutionJson: text('resolution_json'),
  },
  (table) => [
    check(
      'thread_request_catalog_status_check',
      sql`${table.status} in ('pending', 'resolved', 'rejected', 'cancelled')`,
    ),
    index('thread_request_catalog_pending_idx').on(
      table.threadId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const threadCheckpointCatalog = sqliteTable(
  'thread_checkpoint_catalog',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threadCatalog.id, { onDelete: 'cascade' }),
    turnId: text('turn_id'),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    firstKeptSeq: integer('first_kept_seq'),
    tokensBefore: integer('tokens_before'),
    artifactId: text('artifact_id').references(() => artifacts.id),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('thread_checkpoint_catalog_thread_seq_idx').on(
      table.threadId,
      table.createdAt,
    ),
  ],
);

export const threadLockCatalog = sqliteTable('thread_lock_catalog', {
  threadId: text('thread_id')
    .primaryKey()
    .references(() => threadCatalog.id, { onDelete: 'cascade' }),
  ownerId: text('owner_id').notNull(),
  acquiredAt: text('acquired_at').notNull(),
  expiresAt: text('expires_at'),
  heartbeatAt: text('heartbeat_at').notNull(),
});

/** Drizzle 查询使用的 schema 对象。 */
export const codingStorageSchema = {
  meta,
  artifacts,
  artifactReferences,
  repositories,
  workspaces,
  workspaceRepositories,
  workspaceSyncRuns,
  usageRecords,
  usageModelCalls,
  usagePriceSnapshots,
  usageReportCache,
  memoryJobs,
  checkpoints,
  checkpointFileChanges,
  checkpointRollbacks,
  taskBoards,
  tasks,
  taskDependencies,
  threadCatalog,
  threadTurnCatalog,
  threadItemCatalog,
  threadRequestCatalog,
  threadCheckpointCatalog,
  threadLockCatalog,
};

/** SQLite 中常用的当前时间表达式，只用于少量原子 upsert。 */
export const currentTimestamp = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
