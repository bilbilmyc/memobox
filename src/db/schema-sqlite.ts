import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * 本地模式用的 SQLite 版 schema（与 src/db/schema.ts 的 pg 版对应）。
 * 向量存 JSON 文本列，余弦相似度在 JS 里算——个人规模（几千条）够用。
 */
export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    kind: text("kind").notNull().default("fact"),
    source: text("source").notNull().default("mcp"),
    entities: text("entities").notNull().default("[]"),
    embedding: text("embedding"), // JSON number[] | null
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("memories_created_at_idx").on(t.createdAt)]
);

export const queryLog = sqliteTable("query_log", {
  id: text("id").primaryKey(),
  query: text("query").notNull(),
  recalledIds: text("recalled_ids").notNull().default("[]"), // JSON string[]
  latencyMs: integer("latency_ms"),
  createdAt: integer("created_at").notNull(),
});

/** 评测标注表：与 pg 版 schema 对应（v1.3 启用），双外键级联 */
export const evalLabels = sqliteTable(
  "eval_labels",
  {
    id: text("id").primaryKey(),
    queryLogId: text("query_log_id").notNull(),
    memoryId: text("memory_id").notNull(),
    relevant: integer("relevant").notNull(), // 0/1
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("eval_labels_pair_idx").on(t.queryLogId, t.memoryId)]
);

/** 图谱表：与 pg 版 schema 对应（v1.2 启用） */
export const entityNodes = sqliteTable("entity_nodes", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

export const memoryEntityEdges = sqliteTable("memory_entity_edges", {
  id: text("id").primaryKey(),
  memoryId: text("memory_id").notNull(),
  entityId: text("entity_id").notNull(),
  relation: text("relation").notNull().default("tag"),
  weight: integer("weight").notNull().default(1),
});

export type SqliteMemoryRow = typeof memories.$inferSelect;

/**
 * Better Auth 标准表的 SQLite 版（v1.5，与 pg 版 schema 对应）。
 * 时间戳是毫秒整数；boolean 语义的列（email_verified）存 0/1。
 */

/** 认证用户表（时间列用 timestamp 模式：Better Auth 传 Date，drizzle 负责转毫秒） */
export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/** 会话表 */
export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/** 账号表（password 列存哈希） */
export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", {
    mode: "timestamp",
  }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", {
    mode: "timestamp",
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/** 一次性验证令牌表（邮箱验证等，当前未启用） */
export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/**
 * 认证表的幂等建表 SQL——SQLiteStore 建库和 auth 模块开自己的连接时
 * 各执行一遍（CREATE IF NOT EXISTS，重复无害）。
 */
export const AUTH_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    ip_address TEXT,
    user_agent TEXT,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at INTEGER,
    refresh_token_expires_at INTEGER,
    scope TEXT,
    password TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_user_idx ON session(user_id);
  CREATE INDEX IF NOT EXISTS account_user_idx ON account(user_id);
`;
