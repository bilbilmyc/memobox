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
 * memories — the core table. MVP retrieval is pgvector; the entity-graph
 * tables below are created now but only used from v1.1 (see CLAUDE.md
 * decision log).
 *
 * Embedding size 1536 fits text-embedding-3-small. Decide the final
 * embedding model BEFORE the first migration is applied anywhere —
 * e.g. bge-m3 (Chinese-friendly) needs 1024.
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
    embedding: vector("embedding", { dimensions: 1536 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("memories_created_at_idx").on(t.createdAt)]
);

/** Reserved for v1.1: graph retrieval over extracted entities. */
export const entityNodes = pgTable("entity_nodes", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  type: text("type"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Reserved for v1.1: memory ↔ entity edges with relation types. */
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
 * query_log — every search query and what was recalled. This is day-1
 * groundwork for the eval set (decision log: evals are the moat).
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
