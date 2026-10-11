import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { getDb } from "./index";
import {
  entityNodes,
  evalLabels,
  memories,
  memoryEntityEdges,
  queryLog,
  type MemoryRow,
} from "./schema";
import { createEmbedder, type EmbeddingProvider } from "@/lib/embeddings";
import {
  computeBenchmark,
  expandByEntities,
  percentile,
  scoreMemories,
  type EntityCount,
  type EvalStats,
  type Label,
  type Memory,
  type MemoryStore,
  type QueryLogEntry,
} from "@/lib/memory";

type SaveInput = Parameters<MemoryStore["save"]>[0];

/**
 * Postgres 版 MemoryStore。检索：配了 embedding provider 就走 pgvector
 * 余弦；否则（以及语义检索空手而归时）回退到对最近 500 条做关键词打分。
 * v1.2：实体图谱扩展补满剩余名额；每次检索都写入 query_log 供评测。
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

  /** 让 entity_nodes / memory_entity_edges 与某条记忆的实体列表保持一致 */
  private async syncEdges(memoryId: string, entities: string[]) {
    const db = getDb();
    await db
      .delete(memoryEntityEdges)
      .where(eq(memoryEntityEdges.memoryId, memoryId));
    const unique = [...new Set(entities.filter(Boolean))];
    if (unique.length === 0) return;
    await db
      .insert(entityNodes)
      .values(unique.map((name) => ({ name })))
      .onConflictDoNothing();
    const nodes = await db
      .select()
      .from(entityNodes)
      .where(inArray(entityNodes.name, unique));
    const byName = new Map(nodes.map((n) => [n.name, n.id]));
    await db.insert(memoryEntityEdges).values(
      unique.map((name) => ({
        memoryId,
        entityId: byName.get(name)!,
        relation: "tag",
        weight: 1,
      }))
    );
  }

  async save(input: SaveInput): Promise<Memory> {
    let embedding: number[] | undefined;
    if (this.embedder) {
      try {
        embedding = await this.embedder.embed(input.content);
      } catch (e) {
        // 可用性优先：embedding 失败也照常落库（不带向量）
        console.error("[memobox] embedding 失败，按无向量保存：", e);
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
    await this.syncEdges(row.id, row.entities);
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
        console.error("[memobox] 语义检索失败，回退关键词：", e);
      }
    }
    if (hits.length === 0) {
      hits = await this.keywordSearch(query, limit);
    }

    // v1.2 图谱扩展：锚点 = 直接命中记忆的实体 ∪ 查询词
    const anchors = [
      ...new Set([
        ...hits.flatMap((h) => h.entities ?? []),
        ...query.toLowerCase().split(/\s+/).filter(Boolean),
      ]),
    ];
    if (anchors.length > 0) {
      try {
        // drizzle 的模板会把裸 JS 数组拆成多个占位符，?| 需要的是单个
        // text[] 参数——显式拼 ARRAY[...]::text[]（逐项参数化，无注入面）
        const anchorArray = sql`ARRAY[${sql.join(
          anchors.map((a) => sql`${a}`),
          sql`, `
        )}]::text[]`;
        const conditions = [sql`${memories.entities} ?| ${anchorArray}`];
        if (hits.length > 0) {
          conditions.push(
            notInArray(
              memories.id,
              hits.map((h) => h.id)
            )
          );
        }
        const rows = await getDb()
          .select()
          .from(memories)
          .where(and(...conditions))
          .orderBy(desc(memories.createdAt))
          .limit(50);
        hits = [
          ...hits,
          ...expandByEntities(
            rows.map((r) => this.toMemory(r)),
            hits,
            anchors,
            limit
          ),
        ];
      } catch (e) {
        // 扩展尽力而为：绝不能因为它让整个检索失败
        console.error("[memobox] 图谱扩展失败：", e);
      }
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

  async get(id: string): Promise<Memory | null> {
    const rows = await getDb()
      .select()
      .from(memories)
      .where(eq(memories.id, id))
      .limit(1);
    return rows.length ? this.toMemory(rows[0]) : null;
  }

  async update(
    id: string,
    patch: { content?: string; kind?: string; entities?: string[] }
  ): Promise<Memory | null> {
    const db = getDb();
    const values: Partial<typeof memories.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (patch.content !== undefined) {
      values.content = patch.content;
      if (this.embedder) {
        try {
          values.embedding = await this.embedder.embed(patch.content);
        } catch {
          values.embedding = null; // 过期向量比没有向量更糟
        }
      } else {
        values.embedding = null;
      }
    }
    if (patch.kind !== undefined) values.kind = patch.kind;
    if (patch.entities !== undefined) values.entities = patch.entities;

    const rows = await db
      .update(memories)
      .set(values)
      .where(eq(memories.id, id))
      .returning();
    if (rows.length === 0) return null;
    if (patch.entities !== undefined) {
      await this.syncEdges(id, patch.entities);
    }
    return this.toMemory(rows[0]);
  }

  async forget(id: string): Promise<boolean> {
    const db = getDb();
    const gone = await db
      .delete(memories)
      .where(eq(memories.id, id))
      .returning({ id: memories.id });
    if (gone.length === 0) return false;
    // 边随外键级联删除；顺手清掉不再连着任何边的实体节点
    await db.execute(
      sql`DELETE FROM entity_nodes WHERE id NOT IN (SELECT entity_id FROM memory_entity_edges)`
    );
    return true;
  }

  async recentQueries(limit = 10): Promise<QueryLogEntry[]> {
    const rows = await getDb()
      .select({
        id: queryLog.id,
        query: queryLog.query,
        recalledIds: queryLog.recalledIds,
        latencyMs: queryLog.latencyMs,
        createdAt: queryLog.createdAt,
        // 注意：不能插值 ${queryLog.id}——drizzle 在 select 列表里渲染成裸 "id"，
        // 会被子查询里 eval_labels 自己的 id 列遮蔽（ correlated subquery 列遮蔽）。
        // 显式写 query_log.id 限定外表列。
        relevantIds: sql<string[]>`coalesce((select array_agg(l.memory_id::text) from eval_labels l where l.query_log_id = query_log.id and l.relevant), '{}')`,
      })
      .from(queryLog)
      .orderBy(desc(queryLog.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      query: r.query,
      recalled: r.recalledIds.length,
      latencyMs: r.latencyMs,
      createdAt: r.createdAt.getTime(),
      relevantIds: r.relevantIds ?? [],
    }));
  }

  async topEntities(limit = 20): Promise<EntityCount[]> {
    const rows = await getDb()
      .select({
        name: entityNodes.name,
        memories: sql<number>`count(${memoryEntityEdges.memoryId})::int`,
      })
      .from(entityNodes)
      .innerJoin(memoryEntityEdges, eq(memoryEntityEdges.entityId, entityNodes.id))
      .groupBy(entityNodes.name)
      .orderBy(desc(sql`count(${memoryEntityEdges.memoryId})`), entityNodes.name)
      .limit(limit);
    return rows;
  }

  async evalStats(): Promise<EvalStats> {
    const [agg] = await getDb()
      .select({
        totalQueries: sql<number>`count(*)::int`,
        zeroRecall: sql<number>`count(*) filter (where jsonb_array_length(${queryLog.recalledIds}) = 0)::int`,
        p50LatencyMs: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${queryLog.latencyMs}), 0)::int`,
        p95LatencyMs: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${queryLog.latencyMs}), 0)::int`,
      })
      .from(queryLog);
    return agg;
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

  // ---- v1.3 标注式评测 ----

  async label(
    queryLogId: string,
    memoryId: string,
    relevant: boolean
  ): Promise<void> {
    await getDb()
      .insert(evalLabels)
      .values({ queryLogId, memoryId, relevant })
      .onConflictDoUpdate({
        target: [evalLabels.queryLogId, evalLabels.memoryId],
        set: { relevant },
      });
  }

  async unlabel(queryLogId: string, memoryId: string): Promise<void> {
    await getDb()
      .delete(evalLabels)
      .where(
        and(
          eq(evalLabels.queryLogId, queryLogId),
          eq(evalLabels.memoryId, memoryId)
        )
      );
  }

  async getQuery(id: string): Promise<{
    entry: QueryLogEntry;
    recalled: Memory[];
    labels: Label[];
  } | null> {
    const rows = await getDb()
      .select()
      .from(queryLog)
      .where(eq(queryLog.id, id))
      .limit(1);
    if (rows.length === 0) return null;
    const r = rows[0];
    const found = r.recalledIds.length
      ? await getDb()
          .select()
          .from(memories)
          .where(inArray(memories.id, r.recalledIds))
      : [];
    const byId = new Map(found.map((m) => [m.id, this.toMemory(m)]));
    const labels = await getDb()
      .select()
      .from(evalLabels)
      .where(eq(evalLabels.queryLogId, id));
    return {
      entry: {
        id: r.id,
        query: r.query,
        recalled: r.recalledIds.length,
        latencyMs: r.latencyMs,
        createdAt: r.createdAt.getTime(),
      },
      // 按当时的召回顺序展示（被遗忘的记忆自然消失）
      recalled: r.recalledIds
        .map((mid) => byId.get(mid))
        .filter((m): m is Memory => Boolean(m)),
      labels: labels.map((l) => ({
        memoryId: l.memoryId,
        relevant: l.relevant,
      })),
    };
  }

  async unlabeledQueries(limit = 20): Promise<QueryLogEntry[]> {
    const rows = await getDb()
      .select()
      .from(queryLog)
      .where(
        sql`not exists (select 1 from eval_labels where eval_labels.query_log_id = ${queryLog.id})`
      )
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

  async benchmark() {
    const rows = await getDb()
      .select({
        id: queryLog.id,
        recalledIds: queryLog.recalledIds,
        memoryId: evalLabels.memoryId,
        relevant: evalLabels.relevant,
      })
      .from(queryLog)
      .innerJoin(evalLabels, eq(evalLabels.queryLogId, queryLog.id));
    const byQuery = new Map<
      string,
      { recalledIds: string[]; labels: Label[] }
    >();
    for (const r of rows) {
      const e = byQuery.get(r.id) ?? { recalledIds: r.recalledIds, labels: [] };
      e.labels.push({ memoryId: r.memoryId, relevant: r.relevant });
      byQuery.set(r.id, e);
    }
    return computeBenchmark([...byQuery.values()]);
  }
}
