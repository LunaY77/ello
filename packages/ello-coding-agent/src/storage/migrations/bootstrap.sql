-- coding-agent 全局 SQLite 初始化脚本。
-- 说明：
-- 1. 只使用幂等 DDL，不依赖版本表。
-- 2. 这是全局库 `~/.ello/state.sqlite` 的启动基线，不会在项目目录创建 SQLite。
-- 3. 表结构只覆盖需要查询、聚合或事务保护的结构化状态。

-- 通用元信息表：给后续导入、报表缓存或一次性标记留入口。
create table if not exists meta (
  key text primary key,
  value text not null,
  updated_at text not null
);

-- 大对象制品元数据：真实内容写到 `~/.ello/artifacts/`。
create table if not exists artifacts (
  id text primary key,
  kind text not null,
  path text not null,
  sha256 text not null,
  byte_size integer not null,
  content_type text,
  created_at text not null
);

-- 全局 repo registry：workspace 通过它关联 repo 元数据。
create table if not exists repositories (
  id text primary key,
  key text not null unique,
  source_url text,
  mirror_path text,
  default_branch text,
  created_at text not null,
  updated_at text not null
);

-- workspace 主表：DB 是唯一事实源。
create table if not exists workspaces (
  id text primary key,
  kind text not null,
  name text not null,
  root_path text not null,
  status text not null,
  branch text,
  tmux_session text,
  last_synced_at text,
  created_at text not null,
  updated_at text not null,
  unique(kind, name)
);

-- workspace 与 repo 的 checkout 关系。
create table if not exists workspace_repositories (
  workspace_id text not null references workspaces(id) on delete cascade,
  repository_id text not null references repositories(id),
  checkout_path text not null,
  branch text,
  status text not null,
  last_git_status text,
  last_synced_at text,
  created_at text not null,
  updated_at text not null,
  primary key(workspace_id, repository_id)
);

-- workspace sync 过程记录。
create table if not exists workspace_sync_runs (
  id text primary key,
  workspace_id text references workspaces(id),
  status text not null,
  checked_count integer not null,
  fixed_count integer not null,
  error_message text,
  started_at text not null,
  completed_at text
);

-- usage 聚合记录：只存安全字段，不存 prompt/tool output。
create table if not exists usage_records (
  id text primary key,
  run_id text,
  invocation text not null,
  provider text,
  model text not null,
  status text not null,
  finish_reason text,
  requests integer not null,
  input_tokens integer not null,
  output_tokens integer not null,
  cache_read_tokens integer not null,
  cache_write_tokens integer not null,
  tool_calls integer not null,
  estimated_cost_usd real,
  started_at text not null,
  completed_at text,
  created_at text not null
);

create index if not exists usage_records_started_at_idx on usage_records(started_at);
create index if not exists usage_records_model_idx on usage_records(model);
create index if not exists usage_records_status_idx on usage_records(status);

-- 价格快照：估算成本只依赖快照，不直接宣称精确账单。
create table if not exists usage_price_snapshots (
  id text primary key,
  provider text not null,
  model text not null,
  input_usd_per_1m real,
  output_usd_per_1m real,
  cache_read_usd_per_1m real,
  cache_write_usd_per_1m real,
  source text,
  effective_at text not null,
  created_at text not null
);

-- usage 报表缓存。
create table if not exists usage_report_cache (
  id text primary key,
  report_key text not null,
  params_json text not null,
  result_json text not null,
  generated_at text not null
);

-- checkpoint 主表。
create table if not exists checkpoints (
  id text primary key,
  run_id text,
  label text,
  status text not null,
  created_at text not null,
  rolled_back_at text
);

-- checkpoint 文件变化表。
create table if not exists checkpoint_file_changes (
  id text primary key,
  checkpoint_id text not null references checkpoints(id) on delete cascade,
  path text not null,
  path_hash text not null,
  change_type text not null,
  before_artifact_id text references artifacts(id),
  after_artifact_id text references artifacts(id),
  before_sha256 text,
  after_sha256 text,
  diff text,
  tool_call_id text,
  created_at text not null
);

create index if not exists checkpoint_file_changes_path_idx on checkpoint_file_changes(path_hash);

-- checkpoint rollback 审计。
create table if not exists checkpoint_rollbacks (
  id text primary key,
  checkpoint_id text not null references checkpoints(id),
  run_id text,
  status text not null,
  error_message text,
  created_at text not null
);

-- task 主表：任务与 workspace/session 正交。
create table if not exists tasks (
  id text primary key,
  list_id text not null,
  subject text not null,
  description text not null,
  active_form text,
  status text not null,
  owner text,
  metadata text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create index if not exists tasks_list_status_idx on tasks(list_id, status);

-- task 依赖关系边。
create table if not exists task_links (
  task_id text not null references tasks(id) on delete cascade,
  relation text not null,
  target_task_id text not null references tasks(id) on delete cascade,
  created_at text not null,
  primary key(task_id, relation, target_task_id)
);

-- task 事件流。
create table if not exists task_events (
  id text primary key,
  task_id text references tasks(id) on delete set null,
  event_type text not null,
  payload text not null default '{}',
  created_at text not null
);

-- task list 的短数字 ID 高水位。
create table if not exists task_counters (
  list_id text primary key,
  next_id integer not null
);

-- 全局结构化 memory。
create table if not exists memory_items (
  id text primary key,
  kind text not null,
  content text not null,
  tags text not null default '[]',
  source text not null,
  confidence real,
  enabled integer not null default 1,
  last_used_at text,
  created_at text not null,
  updated_at text not null,
  archived_at text
);

create index if not exists memory_items_enabled_idx on memory_items(enabled, archived_at);

-- memory 使用记录。
create table if not exists memory_access_log (
  id text primary key,
  memory_item_id text not null references memory_items(id) on delete cascade,
  run_id text,
  used_for text not null,
  created_at text not null
);
