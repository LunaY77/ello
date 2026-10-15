PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_tasks` (
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
	`max_turns` integer NOT NULL,
	`depth` integer NOT NULL,
	`revision` integer NOT NULL,
	`event_sequence` integer NOT NULL,
	`current_tool_json` text,
	`tool_count` integer DEFAULT 0 NOT NULL,
	`recent_tools_json` text DEFAULT '[]' NOT NULL,
	`result_preview` text,
	`error_preview` text,
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
	CONSTRAINT "agent_tasks_context_mode_check" CHECK("__new_agent_tasks"."context_mode" in ('fresh', 'fork')),
	CONSTRAINT "agent_tasks_execution_mode_check" CHECK("__new_agent_tasks"."execution_mode" in ('foreground', 'background')),
	CONSTRAINT "agent_tasks_status_check" CHECK("__new_agent_tasks"."status" in ('queued', 'running', 'completed', 'failed', 'killed', 'recovered')),
	CONSTRAINT "agent_tasks_isolation_check" CHECK("__new_agent_tasks"."isolation" in ('shared', 'worktree', 'container')),
	CONSTRAINT "agent_tasks_depth_check" CHECK("__new_agent_tasks"."depth" >= 1),
	CONSTRAINT "agent_tasks_revision_check" CHECK("__new_agent_tasks"."revision" >= 0),
	CONSTRAINT "agent_tasks_event_sequence_check" CHECK("__new_agent_tasks"."event_sequence" >= 0),
	CONSTRAINT "agent_tasks_tool_count_check" CHECK("__new_agent_tasks"."tool_count" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_agent_tasks`("id", "agent_id", "root_thread_id", "parent_task_id", "resume_from_task_id", "name", "description", "definition_name", "model_selector", "context_mode", "execution_mode", "status", "prompt", "cwd", "isolation", "max_turns", "depth", "revision", "event_sequence", "current_tool_json", "output", "error_message", "usage_json", "sidechain_json", "tools_json", "permission_rules_json", "external_paths_json", "created_at", "started_at", "completed_at", "updated_at") SELECT "id", "agent_id", "root_thread_id", "parent_task_id", "resume_from_task_id", "name", "description", "definition_name", "model_selector", "context_mode", "execution_mode", "status", "prompt", "cwd", "isolation", "max_turns", "depth", "revision", "event_sequence", "current_tool_json", "output", "error_message", "usage_json", "sidechain_json", "tools_json", "permission_rules_json", "external_paths_json", "created_at", "started_at", "completed_at", "updated_at" FROM `agent_tasks`;--> statement-breakpoint
DROP TABLE `agent_tasks`;--> statement-breakpoint
ALTER TABLE `__new_agent_tasks` RENAME TO `agent_tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tasks_agent_id_idx` ON `agent_tasks` (`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tasks_root_name_idx` ON `agent_tasks` (`root_thread_id`,`name`) WHERE "agent_tasks"."name" is not null;--> statement-breakpoint
CREATE INDEX `agent_tasks_root_status_idx` ON `agent_tasks` (`root_thread_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_tasks_parent_task_idx` ON `agent_tasks` (`parent_task_id`,`created_at`);
