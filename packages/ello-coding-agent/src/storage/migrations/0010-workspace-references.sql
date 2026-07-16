-- checkout role 独立于 Git mode：explore/archive 的 detached checkout 仍属于 repos。

alter table workspace_repositories add column checkout_role text;

update workspace_repositories set checkout_role = 'development';

create trigger workspace_repositories_checkout_role_insert
before insert on workspace_repositories
when new.checkout_role is null or new.checkout_role not in ('development', 'reference')
begin
  select raise(abort, 'workspace checkout_role is required');
end;

create trigger workspace_repositories_checkout_role_update
before update of checkout_role on workspace_repositories
when new.checkout_role is null or new.checkout_role not in ('development', 'reference')
begin
  select raise(abort, 'workspace checkout_role is required');
end;
