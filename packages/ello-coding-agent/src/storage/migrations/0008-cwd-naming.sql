-- cwd 是普通运行目录，不与 workspace 产品抽象绑定。

alter table memory_jobs rename column workspace_cwd to cwd;

drop index memory_jobs_extract_source_idx;
drop index memory_jobs_active_dream_idx;
drop index memory_jobs_status_created_idx;

create unique index memory_jobs_extract_source_idx
  on memory_jobs(kind, cwd, session_id, source_leaf_id)
  where kind = 'extract';

create unique index memory_jobs_active_dream_idx
  on memory_jobs(kind, cwd)
  where kind = 'dream' and status in ('queued', 'running');

create index memory_jobs_status_created_idx
  on memory_jobs(cwd, status, created_at);
