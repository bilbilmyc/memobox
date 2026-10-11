import { mkdirSync } from "node:fs";
import { and, desc, eq, sql } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createEmbedder, type EmbeddingProvider } from "@/lib/embeddings";
import {
  computeBenchmark,
  cosineSim,
  expandByEntities,
  percentile,
  scoreMemories,
  tokenize,
  type EntityCount,
  type EvalStats,
  type Label,
  type Memory,
  type MemoryStore,
  type QueryLogEntry,
} from "@/lib/memory";
import * as schema from "./schema-sqlite";
import { defaultDbPath } from "@/lib/paths";

type SaveInput = Parameters<MemoryStore["save"]>[0];

/**
 * SQLite 存储（v2.0 起是唯一后端；零依赖：bun:sqlite 是 Bun 内置的）。
 * 库文件默认 ~/.memobox/memobox.db（MEMOBOX_DB_PATH 可改，":memory:" 供测试）。
 * 语义检索在 JS 里对 JSON 向量算余弦——个人规模（几千条）足够快；
 * 关键词打分是回退路径。v1.2：实体图谱扩展 + 编辑/遗忘 + 评测聚合。
 */
export class SQLiteStore implements MemoryStore {
  readonly backend = "sqlite";
  readonly retrieval: "semantic" | "keyword";

  private readonly db;

  constructor(
    private readonly embedder: EmbeddingProvider | null = createEmbedder(),
    dbPath: string = defaultDbPath()
  ) {
    this.retrieval = embedder ? "semantic" : "keyword";
    // 建好库文件所在目录（":memory:" 除外）
    if (dbPath !== ":memory:") {
      const dir = dbPath.replace(/[/\\][^/\\]+$/, "");
      if (dir && dir !== dbPath) mkdirSync(dir, { recursive: true });
    }
    const client = new Database(dbPath);
    client.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    // 幂等内联 DDL：已存在的库升级时只会补建缺的表/索引
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
      CREATE TABLE IF NOT EXISTS entity_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_entity_edges (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        entity_id TEXT NOT NULL REFERENCES entity_nodes(id) ON DELETE CASCADE,
        relation TEXT NOT NULL DEFAULT 'tag',
        weight INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS edges_memory_idx ON memory_entity_edges(memory_id);
      CREATE TABLE IF NOT EXISTS eval_labels (
        id TEXT PRIMARY KEY,
        query_log_id TEXT NOT NULL REFERENCES query_log(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        relevant INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS eval_labels_pair_idx ON eval_labels(query_log_id, memory_id);
    `);
    this.db = drizzle(client, { schema });
  }

  private toMemory(row: schema.SqliteMemoryRow): Memory {
    let entities: string[] = [];
    try {
      entities = JSON.parse(row.entities);
    } catch {
      // 列内容损坏时按空实体处理
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

  /** 让 entity_nodes / memory_entity_edges 与某条记忆的实体列表保持一致 */
  private syncEdges(memoryId: string, entities: string[]) {
    this.db
      .delete(schema.memoryEntityEdges)
      .where(eq(schema.memoryEntityEdges.memoryId, memoryId))
      .run();
    const unique = [...new Set(entities.filter(Boolean))];
    if (unique.length === 0) return;
    const now = Date.now();
    for (const name of unique) {
      this.db
        .insert(schema.entityNodes)
        .values({ id: crypto.randomUUID(), name, createdAt: now })
        .onConflictDoNothing()
        .run();
    }
    const byName = new Map(
      this.db
        .select()
        .from(schema.entityNodes)
        .all()
        .map((n) => [n.name, n.id])
    );
    this.db
      .insert(schema.memoryEntityEdges)
      .values(
        unique.map((name) => ({
          id: crypto.randomUUID(),
          memoryId,
          entityId: byName.get(name)!,
          relation: "tag",
          weight: 1,
        }))
      )
      .run();
  }

  async save(input: SaveInput): Promise<Memory> {
    const now = Date.now();
    let embedding: string | null = null;
    if (this.embedder) {
      try {
        embedding = JSON.stringify(await this.embedder.embed(input.content));
      } catch (e) {
        // 可用性优先：embedding 失败也照常落库（不带向量）
        console.error("[memobox] embedding 失败，按无向量保存：", e);
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
    this.syncEdges(row.id, input.entities ?? []);
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
            scored.push({
              m: this.toMemory(r),
              sim: cosineSim(qv, JSON.parse(r.embedding)),
            });
          } catch {
            // 跳过损坏的向量
          }
        }
        scored.sort((a, b) => b.sim - a.sim || b.m.createdAt - a.m.createdAt);
        hits = scored.slice(0, limit).map((s) => s.m);
      } catch (e) {
        console.error("[memobox] 语义检索失败，回退关键词：", e);
      }
    }
    if (hits.length === 0) {
      const candidates = this.db
        .select()
        .from(schema.memories)
        .orderBy(desc(schema.memories.createdAt))
        .limit(500)
        .all();
      hits = scoreMemories(
        candidates.map((r) => this.toMemory(r)),
        query,
        limit
      );
    }

    // v1.2 图谱扩展：锚点 = 直接命中记忆的实体 ∪ 查询词
    //（v2.1 起查询词走 tokenize——中文整句也能锚到短实体名）
    const anchors = [
      ...new Set([
        ...hits.flatMap((h) => h.entities ?? []),
        ...tokenize(query),
      ]),
    ];
    if (anchors.length > 0) {
      const anchorSet = new Set(anchors.map((a) => a.toLowerCase()));
      const rows = this.db.select().from(schema.memories).all();
      const candidates = rows
        .map((r) => this.toMemory(r))
        .filter((m) =>
          (m.entities ?? []).some((e) => anchorSet.has(e.toLowerCase()))
        );
      hits = [
        ...hits,
        ...expandByEntities(candidates, hits, anchors, limit),
      ];
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

  async get(id: string): Promise<Memory | null> {
    const rows = this.db
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, id))
      .limit(1)
      .all();
    return rows.length ? this.toMemory(rows[0]) : null;
  }

  async update(
    id: string,
    patch: { content?: string; kind?: string; entities?: string[] }
  ): Promise<Memory | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const values: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.content !== undefined) {
      values.content = patch.content;
      if (this.embedder) {
        try {
          values.embedding = JSON.stringify(
            await this.embedder.embed(patch.content)
          );
        } catch {
          values.embedding = null; // 过期向量比没有向量更糟
        }
      } else {
        values.embedding = null;
      }
    }
    if (patch.kind !== undefined) values.kind = patch.kind;
    if (patch.entities !== undefined)
      values.entities = JSON.stringify(patch.entities);

    this.db
      .update(schema.memories)
      .set(values)
      .where(eq(schema.memories.id, id))
      .run();
    if (patch.entities !== undefined) {
      this.syncEdges(id, patch.entities);
    }
    // 返回前再读一次，保证拿到的是落库后的真实行
    return this.get(id);
  }

  async forget(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    this.db.delete(schema.memories).where(eq(schema.memories.id, id)).run();
    // 边随外键级联删除；顺手清掉不再连着任何边的实体节点
    this.db
      .delete(schema.entityNodes)
      .where(
        sql`${schema.entityNodes.id} NOT IN (SELECT entity_id FROM memory_entity_edges)`
      )
      .run();
    return true;
  }

  async recentQueries(limit = 10): Promise<QueryLogEntry[]> {
    const relevantByQuery = new Map<string, string[]>();
    for (const l of this.db.select().from(schema.evalLabels).all()) {
      if (!l.relevant) continue;
      const list = relevantByQuery.get(l.queryLogId) ?? [];
      list.push(l.memoryId);
      relevantByQuery.set(l.queryLogId, list);
    }
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
      relevantIds: relevantByQuery.get(r.id) ?? [],
    }));
  }

  async topEntities(limit = 20): Promise<EntityCount[]> {
    const edges = this.db.select().from(schema.memoryEntityEdges).all();
    const counts = new Map<string, number>();
    for (const e of edges) {
      counts.set(e.entityId, (counts.get(e.entityId) ?? 0) + 1);
    }
    const nameById = new Map(
      this.db
        .select()
        .from(schema.entityNodes)
        .all()
        .map((n) => [n.id, n.name])
    );
    return [...counts.entries()]
      .map(([id, memories]) => ({ name: nameById.get(id) ?? "?", memories }))
      .sort((a, b) => b.memories - a.memories || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  async evalStats(): Promise<EvalStats> {
    const rows = this.db
      .select({
        recalledIds: schema.queryLog.recalledIds,
        latencyMs: schema.queryLog.latencyMs,
      })
      .from(schema.queryLog)
      .all();
    const latencies = rows
      .map((r) => r.latencyMs ?? 0)
      .sort((a, b) => a - b);
    return {
      totalQueries: rows.length,
      zeroRecall: rows.filter(
        (r) => JSON.parse(r.recalledIds).length === 0
      ).length,
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
    };
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

  // ---- v1.3 标注式评测 ----

  async label(
    queryLogId: string,
    memoryId: string,
    relevant: boolean
  ): Promise<void> {
    this.db
      .insert(schema.evalLabels)
      .values({
        id: crypto.randomUUID(),
        queryLogId,
        memoryId,
        relevant: relevant ? 1 : 0,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [schema.evalLabels.queryLogId, schema.evalLabels.memoryId],
        set: { relevant: relevant ? 1 : 0 },
      })
      .run();
  }

  async unlabel(queryLogId: string, memoryId: string): Promise<void> {
    this.db
      .delete(schema.evalLabels)
      .where(
        and(
          eq(schema.evalLabels.queryLogId, queryLogId),
          eq(schema.evalLabels.memoryId, memoryId)
        )
      )
      .run();
  }

  async getQuery(id: string): Promise<{
    entry: QueryLogEntry;
    recalled: Memory[];
    labels: Label[];
  } | null> {
    const rows = this.db
      .select()
      .from(schema.queryLog)
      .where(eq(schema.queryLog.id, id))
      .limit(1)
      .all();
    if (rows.length === 0) return null;
    const r = rows[0];
    const recalledIds: string[] = JSON.parse(r.recalledIds);
    const byId = new Map(
      this.db
        .select()
        .from(schema.memories)
        .all()
        .map((m) => [m.id, this.toMemory(m)])
    );
    const labels = this.db
      .select()
      .from(schema.evalLabels)
      .where(eq(schema.evalLabels.queryLogId, id))
      .all();
    return {
      entry: {
        id: r.id,
        query: r.query,
        recalled: recalledIds.length,
        latencyMs: r.latencyMs,
        createdAt: r.createdAt,
      },
      // 按当时的召回顺序展示（被遗忘的记忆自然消失）
      recalled: recalledIds
        .map((mid) => byId.get(mid))
        .filter((m): m is Memory => Boolean(m)),
      labels: labels.map((l) => ({
        memoryId: l.memoryId,
        relevant: Boolean(l.relevant),
      })),
    };
  }

  async unlabeledQueries(limit = 20): Promise<QueryLogEntry[]> {
    const labeled = new Set(
      this.db
        .select({ queryLogId: schema.evalLabels.queryLogId })
        .from(schema.evalLabels)
        .all()
        .map((l) => l.queryLogId)
    );
    const rows = this.db
      .select()
      .from(schema.queryLog)
      .orderBy(desc(schema.queryLog.createdAt))
      .all();
    return rows
      .filter((r) => !labeled.has(r.id))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        query: r.query,
        recalled: JSON.parse(r.recalledIds).length,
        latencyMs: r.latencyMs,
        createdAt: r.createdAt,
      }));
  }

  async benchmark() {
    const queries = this.db.select().from(schema.queryLog).all();
    const recalledById = new Map(
      queries.map((q) => [q.id, JSON.parse(q.recalledIds) as string[]])
    );
    const labelsByQuery = new Map<string, Label[]>();
    for (const l of this.db.select().from(schema.evalLabels).all()) {
      const list = labelsByQuery.get(l.queryLogId) ?? [];
      list.push({ memoryId: l.memoryId, relevant: Boolean(l.relevant) });
      labelsByQuery.set(l.queryLogId, list);
    }
    const rows = queries
      .filter((q) => (labelsByQuery.get(q.id)?.length ?? 0) > 0)
      .map((q) => ({
        recalledIds: recalledById.get(q.id) ?? [],
        labels: labelsByQuery.get(q.id) ?? [],
      }));
    return computeBenchmark(rows);
  }

  // ---- v2.4 语义模式启用链路 ----

  /**
   * 补算向量：给所有缺 embedding 的记忆现算（`memobox model enable` 用）。
   * 单条失败跳过不中断（与 save 的可用性优先策略一致）；不动 updated_at
   * ——补算不是编辑，不应扰动排序。
   */
  async backfillEmbeddings(
    onProgress?: (done: number, total: number) => void
  ): Promise<number> {
    if (!this.embedder) return 0;
    const rows = this.db
      .select()
      .from(schema.memories)
      .all()
      .filter((r) => !r.embedding);
    let done = 0;
    for (const r of rows) {
      try {
        const vec = await this.embedder.embed(r.content);
        this.db
          .update(schema.memories)
          .set({ embedding: JSON.stringify(vec) })
          .where(eq(schema.memories.id, r.id))
          .run();
        done++;
      } catch {
        // 单条失败跳过——下次 enable 还能补
      }
      onProgress?.(done, rows.length);
    }
    return done;
  }

  // ---- v1.6 备份/迁移 ----

  async exportAll(): Promise<Memory[]> {
    const rows = this.db
      .select()
      .from(schema.memories)
      .orderBy(schema.memories.createdAt)
      .all();
    return rows.map((r) => this.toMemory(r));
  }

  async importMemories(
    items: Memory[]
  ): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;
    for (const item of items) {
      // drizzle bun-sqlite 的 .run() 不返回 changes——先查后插
      //（导入是单管理员低频操作，多一次 SELECT 无所谓）
      const exists = this.db
        .select({ id: schema.memories.id })
        .from(schema.memories)
        .where(eq(schema.memories.id, item.id))
        .get();
      if (exists) {
        skipped++;
        continue;
      }
      let embedding: string | null = null;
      if (this.embedder) {
        try {
          embedding = JSON.stringify(await this.embedder.embed(item.content));
        } catch {
          // 与 save 同策略：embedding 失败按无向量落库
        }
      }
      this.db
        .insert(schema.memories)
        .values({
          id: item.id,
          content: item.content,
          kind: item.kind ?? "fact",
          source: item.source ?? "mcp",
          entities: JSON.stringify(item.entities ?? []),
          embedding,
          createdAt: item.createdAt,
          updatedAt: Date.now(),
        })
        .onConflictDoNothing({ target: schema.memories.id })
        .run();
      imported++;
      this.syncEdges(item.id, item.entities ?? []);
    }
    return { imported, skipped };
  }
}
