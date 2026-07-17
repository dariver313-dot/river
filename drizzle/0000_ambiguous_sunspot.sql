CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`action` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`approver_email` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE INDEX `approval_requests_vault_status_idx` ON `approval_requests` (`vault_id`,`status`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`item_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_vault_created_idx` ON `audit_events` (`vault_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `vault_items` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vault_items_vault_idx` ON `vault_items` (`vault_id`);--> statement-breakpoint
CREATE TABLE `vault_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vault_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'editor' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_members_vault_email_idx` ON `vault_members` (`vault_id`,`email`);--> statement-breakpoint
CREATE INDEX `vault_members_email_idx` ON `vault_members` (`email`);--> statement-breakpoint
CREATE TABLE `vaults` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vaults_owner_kind_idx` ON `vaults` (`owner_email`,`kind`);