-- Rebuilt rather than altered: SQLite can't add a NOT NULL column without a
-- default to a table that has rows. Existing rows start their retry window
-- when they were created.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`idempotency_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`retry_window_started_at` text NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
INSERT INTO `__new_outbox`("id", "kind", "payload", "idempotency_key", "status", "attempts", "next_attempt_at", "retry_window_started_at", "last_error", "created_at", "sent_at") SELECT "id", "kind", "payload", "idempotency_key", "status", "attempts", "next_attempt_at", "created_at", "last_error", "created_at", "sent_at" FROM `outbox`;--> statement-breakpoint
DROP TABLE `outbox`;--> statement-breakpoint
ALTER TABLE `__new_outbox` RENAME TO `outbox`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `outbox_due_idx` ON `outbox` (`status`,`next_attempt_at`,`created_at`);
