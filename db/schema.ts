import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  passwordSalt: text("password_salt").notNull(),
  passwordHash: text("password_hash").notNull(),
  passwordIterations: integer("password_iterations").notNull(),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
  archivedAt: text("archived_at"),
  quotaBytes: integer("quota_bytes").notNull().default(5_368_709_120),
  maxDocuments: integer("max_documents").notNull().default(500),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("users_username_unique").on(table.username),
  index("users_active_idx").on(table.active),
]);

export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [
  index("sessions_user_idx").on(table.userId),
  index("sessions_expires_idx").on(table.expiresAt),
]);

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  r2Key: text("r2_key").notNull(),
  storageMode: text("storage_mode", { enum: ["user", "legacy"] }).notNull().default("user"),
  displayName: text("display_name").notNull(),
  contentType: text("content_type").notNull(),
  sourceKind: text("source_kind", { enum: ["pdf", "excel", "word"] }).notNull(),
  documentType: text("document_type").notNull().default("미분류"),
  documentTypeId: text("document_type_id"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
}, (table) => [
  index("documents_owner_active_idx").on(table.ownerUserId, table.deletedAt),
  index("documents_owner_type_idx").on(table.ownerUserId, table.documentTypeId),
]);

export const documentTypes = sqliteTable("document_types", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  name: text("name").notNull(),
  parentId: text("parent_id"),
  color: text("color").notNull(),
  keywordsJson: text("keywords_json").notNull().default("[]"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.userId, table.id] }),
  index("document_types_user_parent_idx").on(table.userId, table.parentId, table.sortOrder),
]);

export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  workspaceTitle: text("workspace_title").notNull().default("프로젝트 문서 검색"),
  indexMode: text("index_mode", { enum: ["user", "legacy"] }).notNull().default("user"),
  legacyManifestKey: text("legacy_manifest_key"),
  legacyCorpusKey: text("legacy_corpus_key"),
  legacyConnectedAt: text("legacy_connected_at"),
  updatedAt: text("updated_at").notNull(),
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  detailsJson: text("details_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("audit_logs_actor_created_idx").on(table.actorUserId, table.createdAt),
]);

export const recordShards = sqliteTable("record_shards", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  r2Key: text("r2_key").notNull(),
  kind: text("kind", { enum: ["ocr_overlay", "document_copy"] }).notNull(),
  recordCount: integer("record_count").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("record_shards_user_created_idx").on(table.userId, table.createdAt),
  index("record_shards_document_idx").on(table.documentId),
]);

export const ocrRecordStates = sqliteTable("ocr_record_states", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  recordId: text("record_id").notNull(),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  shardId: text("shard_id").notNull().references(() => recordShards.id, { onDelete: "cascade" }),
  completedAt: text("completed_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.recordId] }),
  index("ocr_record_states_document_idx").on(table.documentId),
]);
