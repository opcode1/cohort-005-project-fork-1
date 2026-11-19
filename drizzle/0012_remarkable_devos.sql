CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`idempotency_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE INDEX `outbox_due_idx` ON `outbox` (`status`,`next_attempt_at`,`created_at`);