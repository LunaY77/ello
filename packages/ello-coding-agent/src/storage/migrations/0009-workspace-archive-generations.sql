-- active selector 唯一；archived/deleted workspace 允许同 selector 多代共存。

create table workspaces_next (
  id text primary key,
  kind text not null,
  name text not null,
  root_path text not null,
  status text not null,
  branch text,
  tmux_session text,
  last_synced_at text,
  created_at text not null,
  updated_at text not null
);

create table workspace_repositories_next (
  workspace_id text not null references workspaces_next(id) on delete cascade,
  repository_id text not null references repositories(id),
  checkout_path text not null,
  checkout_mode text not null,
  branch text,
  head_commit text,
  status text not null,
  last_git_status text,
  last_synced_at text,
  created_at text not null,
  updated_at text not null,
  primary key(workspace_id, repository_id)
);

create table workspace_sync_runs_next (
  id text primary key,
  workspace_id text references workspaces_next(id),
  status text not null,
  checked_count integer not null,
  fixed_count integer not null,
  error_message text,
  started_at text not null,
  completed_at text
);

insert into workspaces_next select * from workspaces;

insert into workspace_repositories_next (
  workspace_id, repository_id, checkout_path, checkout_mode, branch,
  head_commit, status, last_git_status, last_synced_at, created_at, updated_at
)
select
  workspace_id, repository_id, checkout_path, checkout_mode, branch,
  null, status, last_git_status, last_synced_at, created_at, updated_at
from workspace_repositories;

insert into workspace_sync_runs_next select * from workspace_sync_runs;

drop table workspace_repositories;
drop table workspace_sync_runs;
drop table workspaces;

alter table workspaces_next rename to workspaces;
alter table workspace_repositories_next rename to workspace_repositories;
alter table workspace_sync_runs_next rename to workspace_sync_runs;

create unique index workspaces_active_selector_idx
  on workspaces(kind, name)
  where status in ('active', 'missing');

create trigger workspace_repositories_checkout_mode_insert
before insert on workspace_repositories
when new.checkout_mode not in ('branch', 'detached')
begin
  select raise(abort, 'workspace checkout_mode is required');
end;

create trigger workspace_repositories_checkout_mode_update
before update of checkout_mode on workspace_repositories
when new.checkout_mode not in ('branch', 'detached')
begin
  select raise(abort, 'workspace checkout_mode is required');
end;
