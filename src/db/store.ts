import { desc, sql } from "drizzle-orm";
import { getDb } from "./index";
import { memories, queryLog, type MemoryRow } from "./schema";
import { scoreMemories, type Memory, type MemoryStore } from "@/lib/memory";

type SaveInput = Parameters<MemoryStore["save"]>[0];

/**
 * Postgres-backed MemoryStore. v0.2 retrieval is keyword scoring over the
 * 500 most recent rows; pgvector semantic search lands in v0.3 (CLAUDE.md
 * roadmap). Every search is logged to query_log for the eval set.
 */
export class DrizzleStore implements MemoryStore {
  readonly backend = "postgres";

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
    const [row] = await getDb()
      .insert(memories)
      .values({
        content: input.content,
        kind: input.kind,
        entities: input.entities ?? [],
        source: input.source,
      })
      .returning();
    return this.toMemory(row);
  }

  async search(query: string, limit = 5): Promise<Memory[]> {
    const started = Date.now();
    const candidates = await getDb()
      .select()
      .from(memories)
      .orderBy(desc(memories.createdAt))
      .limit(500);
    const hits = scoreMemories(
      candidates.map((r) => this.toMemory(r)),
      query,
      limit
    );
    await getDb().insert(queryLog).values({
      query,
      recalledIds: hits.map((h) => h.id),
      latencyMs: Date.now() - started,
    });
    return hits;
  }

  async list(limit: number): Promise<Memory[]> {
    const rows = await getDb()
      .select()
      .from(memories)
      .orderBy(desc(memories.createdAt))
      .limit(limit);
    return rows.map((r) => this.toMemory(r));
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
