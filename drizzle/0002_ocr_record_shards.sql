CREATE TABLE `record_shards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`kind` text NOT NULL,
	`record_count` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `record_shards_user_created_idx` ON `record_shards` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `record_shards_document_idx` ON `record_shards` (`document_id`);
--> statement-breakpoint
CREATE TABLE `ocr_record_states` (
	`user_id` text NOT NULL,
	`record_id` text NOT NULL,
	`document_id` text NOT NULL,
	`shard_id` text NOT NULL,
	`completed_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `record_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shard_id`) REFERENCES `record_shards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ocr_record_states_document_idx` ON `ocr_record_states` (`document_id`);
