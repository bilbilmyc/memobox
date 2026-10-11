import { mkdirSync } from "node:fs";
import { desc, sql } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createEmbedder, type EmbeddingProvider } from "@/lib/embeddings";
import {
  cosineSim,
  scoreMemories,
  type Memory,
  type MemoryStore,
  type QueryLogEntry,
} from "@/lib/memory";
import * as schema from "./schema-sqlite";

type SaveInput = Parameters<MemoryStore["save"]>[0];

/**
 * SQLite-backed MemoryStore for local mode (zero dependencies: bun:sqlite
 * ships with Bun). Selected when DATABASE_URL is unset; the database file
 * defaults to ./data/memobox.db (override with MEMOBOX_DB_PATH, or
 * ":memory:" for tests). Semantic retrieval computes cosine similarity in
 * JS over stored JSON vectors; keyword scoring is the fallback.
 */
export class SQLiteStore implements MemoryStore {
  readonly backend = "sqlite";
  readonly retrieval: "semantic" | "keyword";

  private readonly db;

  constructor(
    private readonly embedder: EmbeddingProvider | null = createEmbedder(),
    dbPath: string = process.env.MEMOBOX_DB_PATH ?? "data/memobox.db"
  ) {
    this.retrieval = embedder ? "semantic" : "keyword";
    if (dbPath !== ":memory:") {
      const dir = dbPath.replace(/[/\\][^/\\]+$/, "");
      if (dir && dir !== dbPath) mkdirSync(dir, { recursive: true });
    }
    const client = new Database(dbPath);
    client.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    client.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'fact',
        source TEXT NOT NULL DEFAULT 'mcp',
        entities TEXT NOT NULL DEFAULT '[]',
        embedding TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_created_at_idx ON memories(created_at);
      CREATE TABLE IF NOT EXISTS query_log (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        recalled_ids TEXT NOT NULL DEFAULT '[]',
        latency_ms INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    this.db = drizzle(client, { schema });
  }

  private toMemory(row: schema.SqliteMemoryRow): Memory {
    let entities: string[] = [];
    try {
      entities = JSON.parse(row.entities);
    } catch {
      // corrupt column — treat as empty
    }
    return {
      id: row.id,
      content: row.content,
      kind: row.kind,
      entities,
      source: row.source,
      createdAt: row.createdAt,
    };
  }

  async save(input: SaveInput): Promise<Memory> {
    const now = Date.now();
    let embedding: string | null = null;
    if (this.embedder) {
      try {
        embedding = JSON.stringify(await this.embedder.embed(input.content));
      } catch (e) {
        // Availability over smartness: store the memory un-embedded.
        console.error("[memobox] embedding failed, saving without:", e);
      }
    }
    const row = {
      id: crypto.randomUUID(),
      content: input.content,
      kind: input.kind ?? "fact",
      source: input.source ?? "mcp",
      entities: JSON.stringify(input.entities ?? []),
      embedding,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.memories).values(row).run();
    return this.toMemory(row);
  }

  async search(query: string, limit = 5): Promise<Memory[]> {
    const started = Date.now();
    let hits: Memory[] = [];

    if (this.embedder) {
      try {
        const qv = await this.embedder.embed(query);
        const rows = this.db.select().from(schema.memories).all();
        const scored: { m: Memory; sim: number }[] = [];
        for (const r of rows) {
          if (!r.embedding) continue;
          try {
            scored.push({ m: this.toMemory(r), sim: cosineSim(qv, JSON.parse(r.embedding)) });
          } catch {
            // skip corrupt vectors
          }
        }
        scored.sort((a, b) => b.sim - a.sim || b.m.createdAt - a.m.createdAt);
        hits = scored.slice(0, limit).map((s) => s.m);
      } catch (e) {
        console.error("[memobox] semantic search failed, falling back:", e);
      }
    }
    if (hits.length === 0) {
      const candidates = this.db
        .select()
        .from(schema.memories)
        .orderBy(desc(schema.memories.createdAt))
        .limit(500)
        .all();
      hits = scoreMemories(candidates.map((r) => this.toMemory(r)), query, limit);
    }

    this.db
      .insert(schema.queryLog)
      .values({
        id: crypto.randomUUID(),
        query,
        recalledIds: JSON.stringify(hits.map((h) => h.id)),
        latencyMs: Date.now() - started,
        createdAt: Date.now(),
      })
      .run();
    return hits;
  }

  async list(limit: number): Promise<Memory[]> {
    const rows = this.db
      .select()
      .from(schema.memories)
      .orderBy(desc(schema.memories.createdAt))
      .limit(limit)
      .all();
    return rows.map((r) => this.toMemory(r));
  }

  async recentQueries(limit = 10): Promise<QueryLogEntry[]> {
    const rows = this.db
      .select()
      .from(schema.queryLog)
      .orderBy(desc(schema.queryLog.createdAt))
      .limit(limit)
      .all();
    return rows.map((r) => ({
      id: r.id,
      query: r.query,
      recalled: JSON.parse(r.recalledIds).length,
      latencyMs: r.latencyMs,
      createdAt: r.createdAt,
    }));
  }

  async stats(): Promise<{ total: number; searches: number }> {
    const m = this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.memories)
      .get();
    const q = this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.queryLog)
      .get();
    return { total: m?.count ?? 0, searches: q?.count ?? 0 };
  }
}
