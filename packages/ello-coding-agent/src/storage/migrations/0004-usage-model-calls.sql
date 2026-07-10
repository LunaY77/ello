create table usage_model_calls (
  id text primary key,
  run_id text not null,
  turn_index integer not null,
  provider text not null,
  model text not null,
  finish_reason text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  cache_read_tokens integer not null,
  cache_write_tokens integer not null,
  duration_ms real not null,
  system_fingerprint text not null,
  toolset_fingerprint text not null,
  message_prefix_fingerprint text not null,
  compaction_boundary integer not null,
  created_at text not null,
  unique(run_id, turn_index)
);

create index usage_model_calls_run_idx on usage_model_calls(run_id, turn_index);
create index usage_model_calls_created_at_idx on usage_model_calls(created_at);
