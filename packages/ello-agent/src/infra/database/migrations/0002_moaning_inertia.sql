CREATE TABLE `agent_task_events` (
	`root_thread_id` text NOT NULL,
	`task_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`root_sequence` integer NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`task_id`, `sequence`),
	FOREIGN KEY (`root_thread_id`) REFERENCES `agent_task_roots`(`root_thread_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `agent_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_task_events_root_sequence_idx` ON `agent_task_events` (`root_thread_id`,`root_sequence`);--> statement-breakpoint
CREATE INDEX `agent_task_events_task_created_idx` ON `agent_task_events` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_task_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`root_thread_id` text NOT NULL,
	`status` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `agent_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_task_notifications_task_idx` ON `agent_task_notifications` (`task_id`);--> statement-breakpoint
CREATE INDEX `agent_task_notifications_pending_idx` ON `agent_task_notifications` (`root_thread_id`,`delivered_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_task_roots` (
	`root_thread_id` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`root_thread_id` text NOT NULL,
	`parent_task_id` text,
	`resume_from_task_id` text,
	`name` text,
	`description` text NOT NULL,
	`definition_name` text NOT NULL,
	`model_selector` text,
	`context_mode` text NOT NULL,
	`execution_mode` text NOT NULL,
	`status` text NOT NULL,
	`prompt` text NOT NULL,
	`cwd` text NOT NULL,
	`isolation` text NOT NULL,
	`permission_mode` text NOT NULL,
	`max_turns` integer NOT NULL,
	`depth` integer NOT NULL,
	`revision` integer NOT NULL,
	`event_sequence` integer NOT NULL,
	`current_tool_json` text,
	`output` text,
	`error_message` text,
	`usage_json` text,
	`sidechain_json` text NOT NULL,
	`tools_json` text NOT NULL,
	`permission_rules_json` text NOT NULL,
	`external_paths_json` text NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`root_thread_id`) REFERENCES `agent_task_roots`(`root_thread_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_tasks_context_mode_check" CHECK("agent_tasks"."context_mode" in ('fresh', 'fork')),
	CONSTRAINT "agent_tasks_execution_mode_check" CHECK("agent_tasks"."execution_mode" in ('foreground', 'background')),
	CONSTRAINT "agent_tasks_status_check" CHECK("agent_tasks"."status" in ('queued', 'running', 'completed', 'failed', 'killed', 'recovered')),
	CONSTRAINT "agent_tasks_isolation_check" CHECK("agent_tasks"."isolation" in ('shared', 'worktree', 'container')),
	CONSTRAINT "agent_tasks_permission_mode_check" CHECK("agent_tasks"."permission_mode" in ('acceptEdits', 'default', 'bubble')),
	CONSTRAINT "agent_tasks_depth_check" CHECK("agent_tasks"."depth" >= 1),
	CONSTRAINT "agent_tasks_revision_check" CHECK("agent_tasks"."revision" >= 0),
	CONSTRAINT "agent_tasks_event_sequence_check" CHECK("agent_tasks"."event_sequence" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tasks_agent_id_idx` ON `agent_tasks` (`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tasks_root_name_idx` ON `agent_tasks` (`root_thread_id`,`name`) WHERE "agent_tasks"."name" is not null;--> statement-breakpoint
CREATE INDEX `agent_tasks_root_status_idx` ON `agent_tasks` (`root_thread_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_tasks_parent_task_idx` ON `agent_tasks` (`parent_task_id`,`created_at`);