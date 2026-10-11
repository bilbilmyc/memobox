import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * SQLite 版 schema（v2.0 起是唯一存储后端）。
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

/** 评测标注表（v1.3 启用），查询×记忆×相关性 */
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

/** 实体图谱表（v1.2 启用） */
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
