PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`root_thread_id` text NOT NULL,
	`name` text,
	`description` text NOT NULL,
	`definition_name` text NOT NULL,
	`model_selector` text,
	`status` text NOT NULL,
	`task_packet_json` text NOT NULL,
	`cwd` text NOT NULL,
	`isolation` text NOT NULL,
	`max_turns` integer NOT NULL,
	`revision` integer NOT NULL,
	`event_sequence` integer NOT NULL,
	`current_tool_json` text,
	`tool_count` integer DEFAULT 0 NOT NULL,
	`recent_tools_json` text DEFAULT '[]' NOT NULL,
	`result_preview` text,
	`error_preview` text,
	`output` text,
	`error_message` text,
	`result_json` text,
	`usage_json` text,
	`sidechain_json` text NOT NULL,
	`permission_rules_json` text NOT NULL,
	`external_paths_json` text NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`root_thread_id`) REFERENCES `agent_task_roots`(`root_thread_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_tasks_status_check" CHECK("__new_agent_tasks"."status" in ('queued', 'running', 'completed', 'failed', 'blocked', 'stopped')),
	CONSTRAINT "agent_tasks_isolation_check" CHECK("__new_agent_tasks"."isolation" = 'shared'),
	CONSTRAINT "agent_tasks_revision_check" CHECK("__new_agent_tasks"."revision" >= 0),
	CONSTRAINT "agent_tasks_event_sequence_check" CHECK("__new_agent_tasks"."event_sequence" >= 0),
	CONSTRAINT "agent_tasks_tool_count_check" CHECK("__new_agent_tasks"."tool_count" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_agent_tasks`(
	"id", "agent_id", "root_thread_id", "name", "description", "definition_name", "model_selector", "status", "task_packet_json", "cwd", "isolation", "max_turns", "revision", "event_sequence", "current_tool_json", "tool_count", "recent_tools_json", "result_preview", "error_preview", "output", "error_message", "result_json", "usage_json", "sidechain_json", "permission_rules_json", "external_paths_json", "created_at", "started_at", "completed_at", "updated_at"
)
SELECT
	"id",
	"agent_id",
	"root_thread_id",
	"name",
	"description",
	"definition_name",
	"model_selector",
	CASE "status"
		WHEN 'killed' THEN 'stopped'
		WHEN 'recovered' THEN 'failed'
		ELSE "status"
	END,
	json_object(
		'objective', COALESCE(NULLIF(TRIM("prompt"), ''), NULLIF(TRIM("description"), ''), 'Continue the delegated task.'),
		'scope', COALESCE(NULLIF(TRIM("description"), ''), NULLIF(TRIM("cwd"), ''), 'Complete only the delegated task.'),
		'knownFacts', json_array('This task was migrated from the legacy delegation contract.'),
		'constraints', json_array('Preserve the existing working directory and permission boundaries.'),
		'expectedOutcome', COALESCE(NULLIF(TRIM("description"), ''), 'Return the requested delegated result.'),
		'acceptanceEvidence', json_array('Return a clear final result with supporting evidence.')
	),
	"cwd",
	'shared',
	"max_turns",
	"revision",
	"event_sequence",
	"current_tool_json",
	"tool_count",
	"recent_tools_json",
	"result_preview",
	"error_preview",
	"output",
	"error_message",
	CASE "status"
		WHEN 'completed' THEN json_object(
			'status', 'completed',
			'summary', COALESCE(NULLIF(TRIM("output"), ''), 'Legacy subagent task completed.'),
			'evidence', json_array(),
			'remainingRisks', json_array()
		)
		WHEN 'failed' THEN json_object(
			'status', 'failed',
			'summary', 'Legacy subagent task failed.',
			'error', COALESCE(NULLIF(TRIM("error_message"), ''), 'The legacy task failed without an error message.'),
			'evidence', json_array(),
			'retryable', json('false')
		)
		WHEN 'recovered' THEN json_object(
			'status', 'failed',
			'summary', 'Legacy subagent task was interrupted by a Server restart.',
			'error', COALESCE(NULLIF(TRIM("error_message"), ''), 'Server restarted before the legacy task reached a terminal result.'),
			'evidence', json_array(),
			'retryable', json('true')
		)
		WHEN 'killed' THEN json_object(
			'status', 'stopped',
			'summary', 'Legacy subagent task was stopped.',
			'reason', COALESCE(NULLIF(TRIM("error_message"), ''), 'The legacy task was stopped before completion.'),
			'partialWork', CASE WHEN NULLIF(TRIM("output"), '') IS NULL THEN json_array() ELSE json_array("output") END,
			'evidence', json_array()
		)
		ELSE NULL
	END,
	"usage_json",
	"sidechain_json",
	"permission_rules_json",
	"external_paths_json",
	"created_at",
	"started_at",
	"completed_at",
	"updated_at"
FROM `agent_tasks`;--> statement-breakpoint
DROP TABLE `agent_tasks`;--> statement-breakpoint
ALTER TABLE `__new_agent_tasks` RENAME TO `agent_tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tasks_agent_id_idx` ON `agent_tasks` (`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tasks_root_name_idx` ON `agent_tasks` (`root_thread_id`,`name`) WHERE "agent_tasks"."name" is not null;--> statement-breakpoint
CREATE INDEX `agent_tasks_root_status_idx` ON `agent_tasks` (`root_thread_id`,`status`,`created_at`);--> statement-breakpoint
UPDATE `agent_task_notifications`
SET
	"status" = CASE "status"
		WHEN 'killed' THEN 'stopped'
		WHEN 'recovered' THEN 'failed'
		ELSE "status"
	END,
	"payload_json" = json_object(
		'summary', COALESCE(
			json_extract("payload_json", '$.summary'),
			json_extract((SELECT "result_json" FROM `agent_tasks` WHERE `agent_tasks`.`id` = `agent_task_notifications`.`task_id`), '$.summary'),
			'Legacy subagent task reached a terminal result.'
		),
		'result', json((SELECT "result_json" FROM `agent_tasks` WHERE `agent_tasks`.`id` = `agent_task_notifications`.`task_id`))
	)
WHERE EXISTS (
	SELECT 1
	FROM `agent_tasks`
	WHERE `agent_tasks`.`id` = `agent_task_notifications`.`task_id`
		AND `agent_tasks`.`result_json` IS NOT NULL
);
