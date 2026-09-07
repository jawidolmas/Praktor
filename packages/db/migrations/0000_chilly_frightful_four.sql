CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`objective_id` text,
	`task_id` text,
	`run_id` text,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifacts_kind_idx` ON `artifacts` (`kind`);--> statement-breakpoint
CREATE INDEX `artifacts_run_idx` ON `artifacts` (`run_id`);--> statement-breakpoint
CREATE TABLE `counters` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`objective_id` text NOT NULL,
	`task_id` text,
	`run_id` text,
	`level` text NOT NULL,
	`title` text NOT NULL,
	`context` text NOT NULL,
	`options` text NOT NULL,
	`recommendation` text NOT NULL,
	`risk` text NOT NULL,
	`blocked_task_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`answer` text,
	`answered_by` text,
	`answered_at` integer,
	`rationale` text,
	`deadline` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_key_idx` ON `decisions` (`key`);--> statement-breakpoint
CREATE INDEX `decisions_status_idx` ON `decisions` (`status`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`objective_id` text,
	`task_id` text,
	`run_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_ts_idx` ON `events` (`ts`);--> statement-breakpoint
CREATE INDEX `events_objective_idx` ON `events` (`objective_id`,`ts`);--> statement-breakpoint
CREATE INDEX `events_run_idx` ON `events` (`run_id`,`ts`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`tier` text NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memories_tier_scope_idx` ON `memories` (`tier`,`scope_id`);--> statement-breakpoint
CREATE TABLE `objectives` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`repo_path` text NOT NULL,
	`base_ref` text DEFAULT 'HEAD' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`budget` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`matcher` text NOT NULL,
	`severity` text NOT NULL,
	`action` text NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policies_key_idx` ON `policies` (`key`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`objective_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`session_id` text NOT NULL,
	`model` text NOT NULL,
	`effort` text DEFAULT 'high' NOT NULL,
	`worktree_path` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`exit_reason` text,
	`turns` integer DEFAULT 0 NOT NULL,
	`usage` text NOT NULL,
	`cost_usd_estimate` real DEFAULT 0 NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_session_idx` ON `runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `runs_task_idx` ON `runs` (`task_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`objective_id` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`intent` text NOT NULL,
	`task_class` text NOT NULL,
	`acceptance` text NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`budget` text NOT NULL,
	`ruled_out` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`objective_id`) REFERENCES `objectives`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_objective_key_idx` ON `tasks` (`objective_id`,`key`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);