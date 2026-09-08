ALTER TABLE `tasks` ADD `model` text DEFAULT 'claude-sonnet-5' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `effort` text DEFAULT 'medium' NOT NULL;