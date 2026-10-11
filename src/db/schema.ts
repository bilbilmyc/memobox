import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  vector,
  real,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * memories —— 核心表。检索主力是 pgvector；下面的实体图谱表
 * 从建库就一起创建，v1.2 起启用（决策记录见 CLAUDE.md）。
 *
 * 向量维度由第一次生成的迁移锁死：默认 1536（OpenAI
 * text-embedding-3-small），首次迁移前可用 EMBEDDING_DIM 覆盖——
 * 例如 bge-m3 用 1024。之后再改就是破坏性列迁移。
 */
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    content: text("content").notNull(),
    summary: text("summary"),
    kind: text("kind").notNull().default("fact"), // fact | preference | event | decision
    source: text("source").notNull().default("mcp"), // e.g. "claude-code"
    entities: jsonb("entities").$type<string[]>().notNull().default([]),
    embedding: vector("embedding", {
      dimensions: Number(process.env.EMBEDDING_DIM ?? 1536),
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("memories_created_at_idx").on(t.createdAt)]
);

/** 实体节点表：图谱检索用（v1.2 启用，名字唯一） */
export const entityNodes = pgTable("entity_nodes", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  type: text("type"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** 记忆 ↔ 实体边表：带关系类型和权重，双向级联删除 */
export const memoryEntityEdges = pgTable("memory_entity_edges", {
  id: uuid("id").defaultRandom().primaryKey(),
  memoryId: uuid("memory_id")
    .notNull()
    .references(() => memories.id, { onDelete: "cascade" }),
  entityId: uuid("entity_id")
    .notNull()
    .references(() => entityNodes.id, { onDelete: "cascade" }),
  relation: text("relation"),
  weight: real("weight").notNull().default(1),
});

/**
 * eval_labels —— 人工标注：某条检索日志里，哪些记忆「真的相关」。
 * relevant=true 且未被召回的行（补充标注）参与 recall 分母，
 * 这才是真 recall@k 而不只是 precision。v1.3 启用。
 */
export const evalLabels = pgTable(
  "eval_labels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    queryLogId: uuid("query_log_id")
      .notNull()
      .references(() => queryLog.id, { onDelete: "cascade" }),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    relevant: boolean("relevant").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("eval_labels_pair_idx").on(t.queryLogId, t.memoryId)]
);

/**
 * query_log —— 记下每一次检索查询和它召回了什么。
 * 这是评测集的 day-1 铺垫（决策日志：评测集是护城河）。
 */
export const queryLog = pgTable("query_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  query: text("query").notNull(),
  recalledIds: jsonb("recalled_ids").$type<string[]>().notNull().default([]),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type MemoryRow = typeof memories.$inferSelect;

/**
 * 下面四张是 Better Auth（v1.5 引入的开源认证库）的标准表结构，
 * 字段名与 better-auth/adapters/drizzle 的默认约定一致——手写而非
 * CLI 生成，便于和项目迁移管线（drizzle-kit）统一管理。
 * 邮箱+密码模式只用得上 password 列；OAuth 列先留空占位。
 */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** 会话表：token 唯一，落 cookie；过期即失效 */
export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** 账号表：邮箱+密码模式下 password 列存哈希；OAuth 字段留作以后 */
export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** 验证表：邮箱验证/找回密码等一次性令牌（当前未启用，建表备用） */
export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
