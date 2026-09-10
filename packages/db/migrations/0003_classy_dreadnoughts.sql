CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `decisions` ADD `notified_at` integer;--> statement-breakpoint
ALTER TABLE `decisions` ADD `notified_message_id` integer;