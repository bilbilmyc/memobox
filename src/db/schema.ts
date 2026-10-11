import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  vector,
  real,
  integer,
  index,
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
