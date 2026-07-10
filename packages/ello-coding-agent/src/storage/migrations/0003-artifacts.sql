create unique index artifacts_sha256_idx on artifacts(sha256);

create table artifact_references (
  artifact_id text not null references artifacts(id) on delete cascade,
  owner_kind text not null,
  owner_id text not null,
  relation text not null,
  created_at text not null,
  primary key(artifact_id, owner_kind, owner_id, relation)
);

create index artifact_references_owner_idx
  on artifact_references(owner_kind, owner_id);
