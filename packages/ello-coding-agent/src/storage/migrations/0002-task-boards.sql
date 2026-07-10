drop table task_events;
drop table task_links;
drop table task_counters;
drop table tasks;

create table task_boards (
  id text primary key,
  scope_type text not null,
  scope_id text not null,
  next_sequence integer not null,
  created_at text not null,
  archived_at text,
  unique(scope_type, scope_id)
);

create table tasks (
  id text primary key,
  board_id text not null references task_boards(id) on delete cascade,
  sequence integer not null,
  subject text not null,
  description text not null,
  active_form text,
  status text not null,
  owner text,
  metadata text not null,
  created_at text not null,
  updated_at text not null,
  unique(board_id, sequence)
);

create index tasks_board_status_idx on tasks(board_id, status);

create table task_dependencies (
  board_id text not null references task_boards(id) on delete cascade,
  blocker_task_id text not null references tasks(id) on delete cascade,
  blocked_task_id text not null references tasks(id) on delete cascade,
  created_at text not null,
  primary key(board_id, blocker_task_id, blocked_task_id),
  check(blocker_task_id <> blocked_task_id)
);
