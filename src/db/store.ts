import { desc, sql } from "drizzle-orm";
import { getDb } from "./index";
import { memories, queryLog, type MemoryRow } from "./schema";
import { createEmbedder, type EmbeddingProvider } from "@/lib/embeddings";
import {
  scoreMemories,
  type Memory,
  type MemoryStore,
  type QueryLogEntry,
} from "@/lib/memory";

type SaveInput = Parameters<MemoryStore["save"]>[0];

/**
 * Postgres-backed MemoryStore. Retrieval: pgvector cosine search when an
 * embedding provider is configured, otherwise keyword scoring over the
 * 500 most recent rows (and as a fallback when semantic search comes up
 * empty). Every search is logged to query_log for the eval set.
 */
export class DrizzleStore implements MemoryStore {
  readonly backend = "postgres";
  readonly retrieval: "semantic" | "keyword";

  constructor(
    private readonly embedder: EmbeddingProvider | null = createEmbedder()
  ) {
    this.retrieval = embedder ? "semantic" : "keyword";
  }

  private toMemory(row: MemoryRow): Memory {
    return {
      id: row.id,
      content: row.content,
      kind: row.kind,
      entities: row.entities,
      source: row.source,
      createdAt: row.createdAt.getTime(),
    };
  }

  async save(input: SaveInput): Promise<Memory> {
    let embedding: number[] | undefined;
    if (this.embedder) {
      try {
        embedding = await this.embedder.embed(input.content);
      } catch (e) {
        // Availability over smartness: store the memory un-embedded.
        console.error("[memobox] embedding failed, saving without:", e);
      }
    }
    const [row] = await getDb()
      .insert(memories)
      .values({
        content: input.content,
        kind: input.kind,
        entities: input.entities ?? [],
        source: input.source,
        embedding,
      })
      .returning();
    return this.toMemory(row);
  }

  async search(query: string, limit = 5): Promise<Memory[]> {
    const started = Date.now();
    let hits: Memory[] = [];

    if (this.embedder) {
      try {
        const vec = await this.embedder.embed(query);
        const rows = await getDb()
          .select()
          .from(memories)
          .where(sql`${memories.embedding} IS NOT NULL`)
          .orderBy(
            sql`${memories.embedding} <=> ${JSON.stringify(vec)}::vector`
          )
          .limit(limit);
        hits = rows.map((r) => this.toMemory(r));
      } catch (e) {
        console.error("[memobox] semantic search failed, falling back:", e);
      }
    }
    if (hits.length === 0) {
      hits = await this.keywordSearch(query, limit);
    }

    await getDb().insert(queryLog).values({
      query,
      recalledIds: hits.map((h) => h.id),
      latencyMs: Date.now() - started,
    });
    return hits;
  }

  private async keywordSearch(
    query: string,
    limit: number
  ): Promise<Memory[]> {
    const candidates = await getDb()
      .select()
      .from(memories)
      .orderBy(desc(memories.createdAt))
      .limit(500);
    return scoreMemories(
      candidates.map((r) => this.toMemory(r)),
      query,
      limit
    );
  }

  async list(limit: number): Promise<Memory[]> {
    const rows = await getDb()
      .select()
      .from(memories)
      .orderBy(desc(memories.createdAt))
      .limit(limit);
    return rows.map((r) => this.toMemory(r));
  }

  async recentQueries(limit = 10): Promise<QueryLogEntry[]> {
    const rows = await getDb()
      .select()
      .from(queryLog)
      .orderBy(desc(queryLog.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      query: r.query,
      recalled: r.recalledIds.length,
      latencyMs: r.latencyMs,
      createdAt: r.createdAt.getTime(),
    }));
  }

  async stats(): Promise<{ total: number; searches: number }> {
    const db = getDb();
    const [m] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(memories);
    const [q] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(queryLog);
    return { total: m.count, searches: q.count };
  }
}
