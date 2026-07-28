DELETE FROM `artifact_references` WHERE `owner_kind` = 'checkpoint';--> statement-breakpoint
DROP TABLE `checkpoint_file_changes`;--> statement-breakpoint
DROP TABLE `checkpoint_rollbacks`;--> statement-breakpoint
DROP TABLE `checkpoints`;
