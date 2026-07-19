CREATE TABLE `artifact_references` (
	`artifact_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`relation` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`artifact_id`, `owner_kind`, `owner_id`, `relation`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifact_references_owner_idx` ON `artifact_references` (`owner_kind`,`owner_id`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_size` integer NOT NULL,
	`content_type` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_sha256_idx` ON `artifacts` (`sha256`);--> statement-breakpoint
CREATE TABLE `checkpoint_file_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`checkpoint_id` text NOT NULL,
	`path` text NOT NULL,
	`path_hash` text NOT NULL,
	`change_type` text NOT NULL,
	`before_artifact_id` text,
	`after_artifact_id` text,
	`before_sha256` text,
	`after_sha256` text,
	`diff` text,
	`tool_call_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `checkpoints`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`before_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`after_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `checkpoint_file_changes_path_idx` ON `checkpoint_file_changes` (`path_hash`);--> statement-breakpoint
CREATE TABLE `checkpoint_rollbacks` (
	`id` text PRIMARY KEY NOT NULL,
	`checkpoint_id` text NOT NULL,
	`run_id` text,
	`status` text NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `checkpoints`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`label` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`rolled_back_at` text
);
--> statement-breakpoint
CREATE TABLE `memory_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`cwd` text NOT NULL,
	`session_id` text,
	`source_leaf_id` text,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	CONSTRAINT "memory_jobs_kind_check" CHECK("memory_jobs"."kind" in ('extract', 'dream')),
	CONSTRAINT "memory_jobs_status_check" CHECK("memory_jobs"."status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "memory_jobs_shape_check" CHECK(("memory_jobs"."kind" = 'extract' and "memory_jobs"."session_id" is not null and "memory_jobs"."source_leaf_id" is not null) or ("memory_jobs"."kind" = 'dream' and "memory_jobs"."session_id" is null and "memory_jobs"."source_leaf_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_jobs_extract_source_idx` ON `memory_jobs` (`kind`,`cwd`,`session_id`,`source_leaf_id`) WHERE "memory_jobs"."kind" = 'extract';--> statement-breakpoint
CREATE UNIQUE INDEX `memory_jobs_active_dream_idx` ON `memory_jobs` (`kind`,`cwd`) WHERE "memory_jobs"."kind" = 'dream' and "memory_jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX `memory_jobs_status_created_idx` ON `memory_jobs` (`cwd`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`remote_url` text,
	`mirror_path` text,
	`default_branch` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `repositories_remote_url_idx` ON `repositories` (`remote_url`);--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_key_unique` ON `repositories` (`key`);--> statement-breakpoint
CREATE TABLE `task_boards` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`next_sequence` integer NOT NULL,
	`created_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_boards_scope_type_scope_id_unique` ON `task_boards` (`scope_type`,`scope_id`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`board_id` text NOT NULL,
	`blocker_task_id` text NOT NULL,
	`blocked_task_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`board_id`, `blocker_task_id`, `blocked_task_id`),
	FOREIGN KEY (`board_id`) REFERENCES `task_boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocker_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_dependencies_no_self_check" CHECK("task_dependencies"."blocker_task_id" <> "task_dependencies"."blocked_task_id")
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`subject` text NOT NULL,
	`description` text NOT NULL,
	`active_form` text,
	`status` text NOT NULL,
	`owner` text,
	`metadata` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `task_boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_board_status_idx` ON `tasks` (`board_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_board_id_sequence_unique` ON `tasks` (`board_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `thread_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`root_id` text NOT NULL,
	`forked_from_id` text,
	`cwd` text NOT NULL,
	`name` text NOT NULL,
	`preview` text NOT NULL,
	`status` text NOT NULL,
	`archived` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`seq` integer NOT NULL,
	CONSTRAINT "thread_catalog_archived_check" CHECK("thread_catalog"."archived" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `thread_catalog_updated_idx` ON `thread_catalog` ("updated_at" desc);--> statement-breakpoint
CREATE INDEX `thread_catalog_cwd_status_idx` ON `thread_catalog` (`cwd`,`status`,`archived`);--> statement-breakpoint
CREATE TABLE `thread_checkpoint_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`first_kept_seq` integer,
	`tokens_before` integer,
	`artifact_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread_catalog`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `thread_checkpoint_catalog_thread_seq_idx` ON `thread_checkpoint_catalog` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `thread_item_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text,
	`created_at` text NOT NULL,
	`payload_json` text NOT NULL,
	`seq` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread_catalog`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `thread_turn_catalog`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_item_catalog_turn_seq_idx` ON `thread_item_catalog` (`turn_id`,`seq`);--> statement-breakpoint
CREATE TABLE `thread_lock_catalog` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text,
	`heartbeat_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread_catalog`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `thread_request_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`item_id` text NOT NULL,
	`method` text NOT NULL,
	`params_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolution_json` text,
	FOREIGN KEY (`thread_id`) REFERENCES `thread_catalog`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "thread_request_catalog_status_check" CHECK("thread_request_catalog"."status" in ('pending', 'resolved', 'rejected', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `thread_request_catalog_pending_idx` ON `thread_request_catalog` (`thread_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `thread_turn_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`error_code` text,
	`usage_json` text,
	`seq` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread_catalog`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_turn_catalog_thread_seq_idx` ON `thread_turn_catalog` (`thread_id`,`seq`);--> statement-breakpoint
CREATE TABLE `usage_model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`turn_index` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`finish_reason` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`duration_ms` real NOT NULL,
	`system_fingerprint` text NOT NULL,
	`toolset_fingerprint` text NOT NULL,
	`message_prefix_fingerprint` text NOT NULL,
	`compaction_boundary` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_model_calls_run_turn_idx` ON `usage_model_calls` (`run_id`,`turn_index`);--> statement-breakpoint
CREATE INDEX `usage_model_calls_run_idx` ON `usage_model_calls` (`run_id`,`turn_index`);--> statement-breakpoint
CREATE INDEX `usage_model_calls_created_at_idx` ON `usage_model_calls` (`created_at`);--> statement-breakpoint
CREATE TABLE `usage_price_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_usd_per_1m` real,
	`output_usd_per_1m` real,
	`cache_read_usd_per_1m` real,
	`cache_write_usd_per_1m` real,
	`source` text,
	`effective_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`invocation` text NOT NULL,
	`provider` text,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`finish_reason` text,
	`requests` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`tool_calls` integer NOT NULL,
	`estimated_cost_usd` real,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_records_started_at_idx` ON `usage_records` (`started_at`);--> statement-breakpoint
CREATE INDEX `usage_records_model_idx` ON `usage_records` (`model`);--> statement-breakpoint
CREATE INDEX `usage_records_status_idx` ON `usage_records` (`status`);--> statement-breakpoint
CREATE TABLE `usage_report_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`report_key` text NOT NULL,
	`params_json` text NOT NULL,
	`result_json` text NOT NULL,
	`generated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_repositories` (
	`workspace_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`checkout_path` text NOT NULL,
	`checkout_role` text NOT NULL,
	`checkout_mode` text NOT NULL,
	`branch` text,
	`head_commit` text,
	`status` text NOT NULL,
	`last_git_status` text,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `repository_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workspace_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`status` text NOT NULL,
	`checked_count` integer NOT NULL,
	`fixed_count` integer NOT NULL,
	`error_message` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`status` text NOT NULL,
	`branch` text,
	`tmux_session` text,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_active_selector_idx` ON `workspaces` (`kind`,`name`) WHERE "workspaces"."status" in ('active', 'missing');
--> statement-breakpoint
CREATE TRIGGER workspace_repositories_checkout_mode_insert
BEFORE INSERT ON workspace_repositories
WHEN new.checkout_mode NOT IN ('branch', 'detached')
BEGIN
  SELECT raise(abort, 'workspace checkout_mode is required');
END;
--> statement-breakpoint
CREATE TRIGGER workspace_repositories_checkout_mode_update
BEFORE UPDATE OF checkout_mode ON workspace_repositories
WHEN new.checkout_mode NOT IN ('branch', 'detached')
BEGIN
  SELECT raise(abort, 'workspace checkout_mode is required');
END;
--> statement-breakpoint
CREATE TRIGGER workspace_repositories_checkout_role_insert
BEFORE INSERT ON workspace_repositories
WHEN new.checkout_role IS NULL OR new.checkout_role NOT IN ('development', 'reference')
BEGIN
  SELECT raise(abort, 'workspace checkout_role is required');
END;
--> statement-breakpoint
CREATE TRIGGER workspace_repositories_checkout_role_update
BEFORE UPDATE OF checkout_role ON workspace_repositories
WHEN new.checkout_role IS NULL OR new.checkout_role NOT IN ('development', 'reference')
BEGIN
  SELECT raise(abort, 'workspace checkout_role is required');
END;
