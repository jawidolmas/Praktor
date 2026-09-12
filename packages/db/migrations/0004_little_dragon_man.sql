ALTER TABLE `objectives` ADD `on_failure` text DEFAULT 'escalate' NOT NULL;--> statement-breakpoint
ALTER TABLE `objectives` ADD `model` text DEFAULT 'claude-sonnet-5' NOT NULL;--> statement-breakpoint
ALTER TABLE `objectives` ADD `effort` text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE `objectives` ADD `max_attempts` integer DEFAULT 3 NOT NULL;