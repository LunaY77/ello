-- repo registry 与 workspace checkout 的正式产品模型。

alter table repositories rename column source_url to remote_url;
alter table workspace_repositories add column checkout_mode text;

update workspace_repositories
set checkout_mode = case when branch is null then 'detached' else 'branch' end;

-- SQLite 不能为新增列直接补 not null 约束，触发器保证后续写入严格。
create trigger workspace_repositories_checkout_mode_insert
before insert on workspace_repositories
when new.checkout_mode is null or new.checkout_mode not in ('branch', 'detached')
begin
  select raise(abort, 'workspace checkout_mode is required');
end;

create trigger workspace_repositories_checkout_mode_update
before update of checkout_mode on workspace_repositories
when new.checkout_mode is null or new.checkout_mode not in ('branch', 'detached')
begin
  select raise(abort, 'workspace checkout_mode is required');
end;

create index repositories_remote_url_idx on repositories(remote_url);
