import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
