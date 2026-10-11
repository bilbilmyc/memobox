import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * SQLite mirror of the pg schema (src/db/schema.ts) for local mode.
 * Vectors live as JSON text; cosine similarity is computed in JS —
 * fine at personal scale (thousands of rows).
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

export type SqliteMemoryRow = typeof memories.$inferSelect;
