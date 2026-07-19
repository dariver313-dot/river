ALTER TABLE `vault_items` ADD `key_id` text NOT NULL DEFAULT 'legacy';
--> statement-breakpoint
ALTER TABLE `vault_items` ADD `encryption_version` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `signature` text;
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `signature_key_id` text;
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `event_version` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `sequence` integer;
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `previous_hash` text;
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `chain_hash` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_vault_sequence_idx` ON `audit_events` (`vault_id`,`sequence`);
--> statement-breakpoint
CREATE TABLE `audit_chain_states` (
	`vault_id` text PRIMARY KEY NOT NULL,
	`last_sequence` integer NOT NULL,
	`head_hash` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_rate_limits` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`window_started_at` integer NOT NULL,
	`request_count` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `request_rate_limits_expiry_idx` ON `request_rate_limits` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `security_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`recent_verified_at` text NOT NULL,
	`last_active_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `security_sessions_email_idx` ON `security_sessions` (`email`,`expires_at`);
