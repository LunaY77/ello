create table memory_jobs (
  id text primary key,
  kind text not null check (kind in ('extract', 'dream')),
  workspace_cwd text not null,
  session_id text,
  source_leaf_id text,
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  attempts integer not null,
  error_message text,
  created_at text not null,
  started_at text,
  completed_at text,
  check (
    (kind = 'extract' and session_id is not null and source_leaf_id is not null)
    or (kind = 'dream' and session_id is null and source_leaf_id is null)
  )
);

create unique index memory_jobs_extract_source_idx
  on memory_jobs(kind, workspace_cwd, session_id, source_leaf_id)
  where kind = 'extract';

create unique index memory_jobs_active_dream_idx
  on memory_jobs(kind, workspace_cwd)
  where kind = 'dream' and status in ('queued', 'running');

create index memory_jobs_status_created_idx
  on memory_jobs(workspace_cwd, status, created_at);
