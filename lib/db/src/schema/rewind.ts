import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const branchStatus = pgEnum("branch_status", [
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
]);

export const stepKind = pgEnum("step_kind", [
  "user",
  "assistant",
  "tool_call",
  "tool_result",
]);

export const repos = pgTable("repos", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  bundleKey: text("bundle_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id"),
  repoId: uuid("repo_id").notNull().references(() => repos.id),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '30 days'`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("sessions_retention_idx").on(table.deletedAt, table.expiresAt),
]);

export const branches = pgTable("branches", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id),
  parentBranchId: uuid("parent_branch_id"),
  forkStepIndex: integer("fork_step_index"),
  modelId: text("model_id").notNull(),
  systemPrompt: text("system_prompt").notNull().default(""),
  taskPrompt: text("task_prompt").notNull(),
  status: branchStatus("status").notNull().default("queued"),
  stepCount: integer("step_count").notNull().default(0),
  totalInputTokens: integer("total_input_tokens").notNull().default(0),
  totalOutputTokens: integer("total_output_tokens").notNull().default(0),
  bundleKey: text("bundle_key"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const steps = pgTable("steps", {
  id: uuid("id").defaultRandom().primaryKey(),
  branchId: uuid("branch_id").notNull().references(() => branches.id),
  stepIndex: integer("index").notNull(),
  kind: stepKind("kind").notNull(),
  content: jsonb("content").notNull(),
  toolName: text("tool_name"),
  toolArgs: jsonb("tool_args"),
  toolResult: text("tool_result"),
  commitHash: text("commit_hash"),
  filesChanged: jsonb("files_changed").$type<string[]>().notNull().default([]),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bundleCleanupQueue = pgTable("bundle_cleanup_queue", {
  bundleKey: text("bundle_key").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// No branch FK: an interrupted upload must remain discoverable after retirement.
export const bundleUploadIntents = pgTable("bundle_upload_intents", {
  bundleKey: text("bundle_key").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("bundle_upload_intents_expiry_idx").on(table.expiresAt),
]);

export type Repo = typeof repos.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Branch = typeof branches.$inferSelect;
export type Step = typeof steps.$inferSelect;