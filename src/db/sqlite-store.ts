import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createEmbedder, embeddingSpace, type EmbeddingProvider } from "@/lib/embeddings";
import {
  computeBenchmark,
  matchesSearchScope,
  expandByEntities,
  KeywordIndex,
  percentile,
  rrfFuse,
  tokenize,
  type EntityCount,
  type EvalStats,
  type Label,
  type Memory,
  type MemoryStore,
  type MemoryQuery,
  type SearchScope,
  type BackfillReport,
  type QueryLogEntry,
} from "@/lib/memory";
import * as schema from "./schema-sqlite";
import { defaultDbPath } from "@/lib/paths";
import { validateMemoryInput } from "@/lib/memory-validation";
import { explainSearch, type RankedMemory, type SearchReport, type SemanticStatus } from "@/lib/search-report";
import { maintenanceInputSchema, maintenancePlanSchema, createMaintenancePlan, suggestMaintenance, validateMaintenanceSnapshot, writeMaintenanceBackup, normalizeReplacement, validateRestoreItems,
  type MaintenanceInput, type MaintenancePlan, type MaintenanceScan, type MaintenanceSuggestions, type MaintenanceOptions, type MaintenanceResult, type RestoreResult } from "@/lib/maintenance";

type SaveInput = Parameters<MemoryStore["save"]>[0];
type CachedVector = { vec: Float32Array; space: string; m: Memory; normSquared: number };
/** 只筛选语义候选；关键词精确匹配和实体扩展不受该门槛影响。 */
const MIN_SEMANTIC_SIMILARITY = 0.35;

const normSquared = (vec: Float32Array): number => {
  let total = 0; for (let i = 0; i < vec.length; i++) total += vec[i] * vec[i]; return total;
};
/** 独立热点让 JIT 优化类型稳定的向量循环，避免捕获异步查询变量。 */
function vectorDot(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const size = a.length;
  let i = 0;
  // 保留原来的累加顺序，同时减少每四维一次的循环判断。
  for (; i + 3 < size; i += 4) {
    dot += a[i] * b[i]; dot += a[i + 1] * b[i + 1];
    dot += a[i + 2] * b[i + 2]; dot += a[i + 3] * b[i + 3];
  }
  for (; i < size; i++) dot += a[i] * b[i];
  return dot;
}

function validVector(vec: ArrayLike<number>): boolean {
  if (vec.length === 0) return false;
  for (let i = 0; i < vec.length; i++) {
    if (typeof vec[i] !== "number" || !Number.isFinite(vec[i])) return false;
  }
  return true;
}

/** 防止端点返回非数值，或有限的 double 转 Float32 后溢出。 */
function toVector(raw: number[]): Float32Array {
  if (!validVector(raw)) throw new Error("invalid embedding vector");
  const vec = Float32Array.from(raw);
  if (!validVector(vec)) throw new Error("invalid Float32 embedding vector");
  return vec;
}

/** SQLite lower 只折叠 ASCII；补上过滤文本中的 Unicode 大小写字符。 */
function foldedSql(expression: SQL, text: string): SQL {
  let folded = sql`lower(${expression})`;
  for (const char of new Set(text.toLowerCase())) {
    const upper = char.toUpperCase();
    if (char.codePointAt(0)! > 127 && upper !== char && [...upper].length === 1) folded = sql`replace(${folded}, ${upper}, ${char})`;
  }
  return folded;
}

/**
 * v2.6：向量在库里的形态是 Float32 BLOB（每维 4 字节，读出零拷贝成
 * Float32Array 视图）；v2.5 及以前存的是 JSON 文本，SQLiteStore 打开时
 * 自动一次性迁移。两种形态都能解，损坏内容返回 null 交补算链路处理。
 */
export function encodeEmbedding(vec: number[] | Float32Array): Uint8Array {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

export function decodeEmbedding(raw: unknown): Float32Array | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    // v2.5 遗留的 JSON 文本向量
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      return toVector(arr);
    } catch {
      return null;
    }
  }
  if (raw instanceof Uint8Array) {
    if (raw.byteLength === 0 || raw.byteLength % 4 !== 0) return null;
    // byteOffset 非 4 对齐时不能直接视图，复制一份再转（bun:sqlite 正常对齐）
    if (raw.byteOffset % 4 === 0) {
      const vec = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      return validVector(vec) ? vec : null;
    }
    const copy = new Uint8Array(raw.byteLength);
    copy.set(raw);
    const vec = new Float32Array(copy.buffer, 0, raw.byteLength / 4);
    return validVector(vec) ? vec : null;
  }
  return null;
}

/**
 * SQLite 存储（v2.0 起是唯一后端；零依赖：bun:sqlite 是 Bun 内置的）。
 * 库文件默认 ~/.memobox/memobox.db（MEMOBOX_DB_PATH 可改，":memory:" 供测试）。
 * v2.6 检索：全库 BM25（进程内 KeywordIndex 缓存，写入增量维护）+
 * 语义余弦（进程内向量缓存）→ RRF 融合；实体图谱扩展补满名额。
 */
export class SQLiteStore implements MemoryStore {
  readonly backend = "sqlite";
  readonly retrieval: "semantic" | "keyword";

  private readonly db;
  /** 原生连接（close() 用；drizzle 句柄不暴露关闭） */
  private readonly client: Database;
  /** v2.6 进程内缓存：全库 BM25 索引（写路径增量维护） */
  private kwIndex: KeywordIndex | null = null;
  /** v2.6 进程内缓存：id → 向量 + 记忆（写路径增量维护） */
  private vecCache: Map<string, CachedVector> | null = null;
  /** 对应缓存快照的记忆版本；检索日志写入不会改变它。 */
  private cacheRevision = -1;

  constructor(
    private readonly embedder: EmbeddingProvider | null = createEmbedder(),
    private readonly dbPath: string = defaultDbPath()
  ) {
    this.retrieval = embedder ? "semantic" : "keyword";
    // 建好库文件所在目录（":memory:" 除外）
    if (dbPath !== ":memory:") {
      const dir = dbPath.replace(/[/\\][^/\\]+$/, "");
      if (dir && dir !== dbPath) mkdirSync(dir, { recursive: true });
    }
    const client = new Database(dbPath);
    client.exec("PRAGMA busy_timeout = 5000");
    client.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    // 同时启动的客户端串行升级，不能看见另一连接只建了一半的表。
    client.transaction(() => {
      // 幂等内联 DDL：已存在的库升级时只会补建缺的表/索引
      client.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'fact',
          source TEXT NOT NULL DEFAULT 'mcp',
          entities TEXT NOT NULL DEFAULT '[]',
          embedding BLOB,
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
      const columns = client.query("PRAGMA table_info(memories)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "embedding_space")) {
        client.exec("ALTER TABLE memories ADD COLUMN embedding_space TEXT");
      }
      // 触发器覆盖所有连接（包括直接 SQL）；版本号与记忆变动一起提交或回滚。
      client.exec(`
        CREATE TABLE IF NOT EXISTS memory_state (
          id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO memory_state (id, revision) VALUES (1, 0);
        CREATE TRIGGER IF NOT EXISTS memories_revision_insert AFTER INSERT ON memories
          BEGIN UPDATE memory_state SET revision = revision + 1 WHERE id = 1; END;
        CREATE TRIGGER IF NOT EXISTS memories_revision_update AFTER UPDATE ON memories
          BEGIN UPDATE memory_state SET revision = revision + 1 WHERE id = 1; END;
        CREATE TRIGGER IF NOT EXISTS memories_revision_delete AFTER DELETE ON memories
          BEGIN UPDATE memory_state SET revision = revision + 1 WHERE id = 1; END;
      `);
      // v2.6 一次性迁移：旧库的 JSON 文本向量 → Float32 BLOB
      //（typeof 过滤后转完即空转，开销可忽略；损坏向量清掉交补算链路重算）
      const legacy = client
        .query("SELECT id, embedding FROM memories WHERE typeof(embedding) = 'text'")
        .all() as { id: string; embedding: string }[];
      if (legacy.length > 0) {
        const upd = client.prepare("UPDATE memories SET embedding = ? WHERE id = ?");
        for (const row of legacy) {
          const vec = decodeEmbedding(row.embedding);
          upd.run(vec ? encodeEmbedding(vec) : null, row.id);
        }
      }
    }).immediate();
    this.db = drizzle(client, { schema });
    this.client = client;
  }

  /**
   * 关闭底层连接（测试/单进程场景用；MCP 常驻服务随进程退出自然关闭，
   * Windows 下不关句柄会锁住库文件）。
   */
  close(): void {
    // Drizzle 的 prepare 语句可能仍被缓存引用；严格关闭会一并 finalize，
    // 立即释放 Windows 文件句柄，不等全进程 GC 才允许备份/替换/测试清理。
    this.client.close(true);
    this.kwIndex = null;
    this.vecCache = null;
  }

  private memoryRevision(): number {
    const row = this.client.query("SELECT revision FROM memory_state WHERE id = 1").get() as { revision: number };
    return row.revision;
  }

  /** 在同一读/写事务中检查版本，避免缓存版本和读到的行属于不同快照。 */
  private refreshCaches(): void {
    const revision = this.memoryRevision();
    if (revision !== this.cacheRevision) {
      this.kwIndex = null;
      this.vecCache = null;
      this.cacheRevision = revision;
    }
  }

  /** 异步算向量在外部完成；事务只做同步写入，提交成功后再更新缓存。 */
  private writeMemory<T>(write: () => T, onCommit: (value: T) => void): T {
    const { value, revision } = this.client.transaction(() => {
      this.refreshCaches();
      const value = write();
      return { value, revision: this.memoryRevision() };
    }).immediate();
    this.cacheRevision = revision;
    onCommit(value);
    return value;
  }

  private readRow(id: string): schema.SqliteMemoryRow | undefined {
    return this.db.select().from(schema.memories).where(eq(schema.memories.id, id)).get();
  }

  /** 从提交后的完整行更新缓存；编辑分类或实体时沿用数据库里的原向量。 */
  private cacheRow(row: schema.SqliteMemoryRow): void {
    const m = this.toMemory(row);
    this.kwIndex?.add(m);
    const vec = decodeEmbedding(row.embedding);
    if (vec && row.embeddingSpace) this.vecCache?.set(row.id, { vec, space: row.embeddingSpace, m, normSquared: normSquared(vec) });
    else this.vecCache?.delete(row.id);
  }

  /** 惰性建/取全库关键词索引（首次 search 触发；写路径增量维护） */
  private keywordIndex(): KeywordIndex {
    if (!this.kwIndex) {
      this.kwIndex = new KeywordIndex();
      this.kwIndex.rebuild(
        this.db.select({ id: schema.memories.id, content: schema.memories.content, kind: schema.memories.kind,
          source: schema.memories.source, entities: schema.memories.entities, createdAt: schema.memories.createdAt })
          .from(schema.memories).all().map((r) => this.toMemory(r))
      );
    }
    return this.kwIndex;
  }

  /** 惰性建/取向量缓存（首次语义检索触发；写路径增量维护） */
  private vectorCache(): Map<string, CachedVector> {
    if (!this.vecCache) {
      const cache = new Map<string, CachedVector>();
      for (const r of this.db.select().from(schema.memories).all()) {
        const vec = decodeEmbedding(r.embedding);
        if (vec && r.embeddingSpace) cache.set(r.id, { vec, space: r.embeddingSpace, m: this.toMemory(r), normSquared: normSquared(vec) });
      }
      this.vecCache = cache;
    }
    return this.vecCache;
  }

  private toMemory(row: Pick<schema.SqliteMemoryRow, "id" | "content" | "kind" | "source" | "entities" | "createdAt">): Memory {
    let entities: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.entities);
      if (Array.isArray(parsed) && parsed.every(entity => typeof entity === "string")) entities = parsed;
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
        .where(inArray(schema.entityNodes.name, unique))
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
    validateMemoryInput(input);
    const now = Date.now();
    let vec: Float32Array | null = null;
    if (this.embedder) {
      try {
        vec = toVector(await this.embedder.embed(input.content));
      } catch (e) {
        // 可用性优先：embedding 失败也照常落库（不带向量）
        console.error("[memobox] 嵌入失败，已按无向量保存；可用 memobox model reindex 重试");
      }
    }
    const row = {
      id: crypto.randomUUID(),
      content: input.content,
      kind: input.kind ?? "fact",
      source: input.source ?? "mcp",
      entities: JSON.stringify(input.entities ?? []),
      embedding: vec ? encodeEmbedding(vec) : null,
      embeddingSpace: vec && this.embedder ? embeddingSpace(this.embedder, vec.length) : null,
      createdAt: now,
      updatedAt: now,
    };
    const saved = this.writeMemory(() => {
      this.db.insert(schema.memories).values(row).run();
      this.syncEdges(row.id, input.entities ?? []);
      return row;
    }, (saved) => this.cacheRow(saved));
    return this.toMemory(saved);
  }

  search(query: string, limit = 5, scope: SearchScope = {}): Promise<Memory[]> {
    return this.retrieve(query, limit, scope, false);
  }

  searchDetailed(query: string, limit = 5, scope: SearchScope = {}): Promise<SearchReport> {
    return this.retrieve(query, limit, scope, true);
  }

  private retrieve(query: string, limit: number, scope: SearchScope, explain: false): Promise<Memory[]>;
  private retrieve(query: string, limit: number, scope: SearchScope, explain: true): Promise<SearchReport>;
  private async retrieve(query: string, limit: number, scope: SearchScope, explain: boolean): Promise<Memory[] | SearchReport> {
    const started = Date.now();
    const allow = Object.values(scope).some(value => value !== undefined) ? (memory: Memory) => matchesSearchScope(memory, scope) : undefined;
    // 先完成可能等待网络的操作，再打开同步读快照；等待期间的外部写入也可见。
    let qv: Float32Array | null = null;
    let semanticStatus: SemanticStatus = { status: "disabled" };
    if (this.embedder) {
      try {
        qv = toVector(await (this.embedder.embedQuery ?? this.embedder.embed).call(this.embedder, query));
        semanticStatus = { status: "no_matches", reason: "no_compatible_vectors" };
      } catch (e) {
        semanticStatus = { status: "unavailable", reason: "embedding_failed" };
        console.error("[memobox] 语义检索失败，已回退关键词；请检查模型或端点配置");
      }
    }
    const report = this.client.transaction(() => {
      this.refreshCaches();
      // 冷启动的两路索引共用一次库快照，避免重复读出全文和向量。
      if (qv && this.embedder && !this.kwIndex && !this.vecCache) {
        this.kwIndex = new KeywordIndex(); this.vecCache = new Map();
        for (const row of this.db.select().from(schema.memories).all()) this.cacheRow(row);
      }
      const depth = Math.max(limit * 4, 20);
      // 普通检索不组装解释对象；可选功能不增加常驻进程热路径的分配负担。
      const keywordScores = explain ? this.keywordIndex().rank(query, depth, allow) : [];
      const keywordRank = explain ? keywordScores.map(row => row.memory) : this.keywordIndex().search(query, depth, allow);
      let semanticRank: Memory[] = [];
      let semanticScores: RankedMemory[] = [];
      if (qv && this.embedder) {
        const space = embeddingSpace(this.embedder, qv.length);
        const queryNorm = normSquared(qv);
        const scored: { m: Memory; sim: number }[] = [];
        let compatible = 0;
        for (const { vec, m, space: savedSpace, normSquared: savedNorm } of this.vectorCache().values()) {
          if (allow && !allow(m)) continue;
          if (savedSpace !== space || vec.length !== qv.length) continue;
          if (!queryNorm || !savedNorm) continue;
          if (explain) compatible++;
          const sim = vectorDot(qv, vec) / Math.sqrt(queryNorm * savedNorm);
          if (sim >= (this.embedder.minimumSimilarity ?? MIN_SEMANTIC_SIMILARITY)) scored.push({ m, sim });
        }
        scored.sort((a, b) => b.sim - a.sim || b.m.createdAt - a.m.createdAt);
        const selected = scored.slice(0, depth);
        semanticRank = selected.map(s => s.m);
        if (explain) semanticScores = selected.map(s => ({ memory: s.m, score: s.sim }));
        semanticStatus = !queryNorm ? { status: "unavailable", reason: "zero_vector" }
          : semanticRank.length ? { status: "used" }
          : { status: "no_matches", reason: compatible ? "below_threshold" : "no_compatible_vectors" };
      }
      let matches = semanticRank.length > 0
        ? rrfFuse([keywordRank, semanticRank], limit)
        : keywordRank.slice(0, limit);
      // 实体扩展与排名读取相同快照，不能夹入另一连接的新旧版本。
      const anchors = [
        ...new Set([...matches.flatMap((h) => h.entities ?? []), ...tokenize(query)]),
      ];
      if (anchors.length > 0 && matches.length < limit) {
        const linked = this.keywordIndex().linked(anchors);
        const candidates = allow ? linked.filter(allow) : linked;
        matches = [...matches, ...expandByEntities(candidates, matches, anchors, limit)];
      }
      return explain ? explainSearch(matches, keywordScores, semanticScores, semanticStatus, anchors) : matches;
    }).deferred();
    const hits = Array.isArray(report) ? report : report.memories;
    // 日志写入放在读事务外，避免 WAL 读快照升级为写事务时冲突。
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
    return report;
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
    const row = this.readRow(id);
    return row ? this.toMemory(row) : null;
  }

  async query(filters: MemoryQuery): Promise<Memory[]> {
    const m = schema.memories, conditions = [];
    if (filters.text) conditions.push(sql`instr(${foldedSql(sql`${m.content}`, filters.text)}, ${filters.text.toLowerCase()}) > 0`);
    if (filters.kind) conditions.push(eq(m.kind, filters.kind));
    if (filters.source) conditions.push(eq(m.source, filters.source));
    if (filters.since !== undefined) conditions.push(sql`${m.createdAt} >= ${filters.since}`);
    if (filters.entity) conditions.push(sql`EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(${m.entities}) THEN ${m.entities} ELSE '[]' END)
      WHERE ${foldedSql(sql`value`, filters.entity)} = ${filters.entity.toLowerCase()}
    )`);
    const rows = this.db.select().from(m).where(and(...conditions))
      .orderBy(desc(m.createdAt), desc(m.id)).limit(filters.limit ?? 20).offset(filters.offset ?? 0).all();
    return rows.map(r => this.toMemory(r));
  }

  async update(
    id: string,
    patch: { content?: string; kind?: string; entities?: string[]; source?: string }
  ): Promise<Memory | null> {
    validateMemoryInput(patch, false);
    if (!this.readRow(id)) return null;
    const values: Partial<typeof schema.memories.$inferInsert> = {};
    let vec: Float32Array | null = null;
    if (patch.content !== undefined) {
      values.content = patch.content;
      if (this.embedder) {
        try {
          vec = toVector(await this.embedder.embed(patch.content));
        } catch {
          vec = null; // 过期向量比没有向量更糟
        }
      }
      values.embedding = vec ? encodeEmbedding(vec) : null;
      values.embeddingSpace = vec && this.embedder ? embeddingSpace(this.embedder, vec.length) : null;
    }
    if (patch.kind !== undefined) values.kind = patch.kind;
    if (patch.source !== undefined) values.source = patch.source;
    if (patch.entities !== undefined)
      values.entities = JSON.stringify(patch.entities);

    const updated = this.writeMemory(() => {
      // 算向量期间可能已被另一连接删除，写事务内重新确认。
      if (!this.readRow(id)) return null;
      this.db.update(schema.memories).set({ ...values, updatedAt: Date.now() })
        .where(eq(schema.memories.id, id)).run();
      if (patch.entities !== undefined) this.syncEdges(id, patch.entities);
      return this.readRow(id) ?? null;
    }, (row) => { if (row) this.cacheRow(row); });
    return updated ? this.toMemory(updated) : null;
  }

  async forget(id: string): Promise<boolean> {
    return this.writeMemory(() => {
      if (!this.readRow(id)) return false;
      this.db.delete(schema.memories).where(eq(schema.memories.id, id)).run();
      // 边随外键级联删除；孤儿实体清理也随事务回滚。
      this.db.delete(schema.entityNodes).where(
        sql`${schema.entityNodes.id} NOT IN (SELECT entity_id FROM memory_entity_edges)`
      ).run();
      return true;
    }, (deleted) => {
      if (deleted) { this.kwIndex?.remove(id); this.vecCache?.delete(id); }
    });
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
   * 补算缺失、损坏、来源未知或模型空间已变化的向量。
   * 单条失败跳过不中断（与 save 的可用性优先策略一致）；不动 updated_at
   * ——补算不是编辑，不应扰动排序。
   */
  async backfillEmbeddings(
    onProgress?: (done: number, total: number) => void
  ): Promise<BackfillReport> {
    const report: BackfillReport = { inspected: 0, needed: 0, processed: 0, succeeded: 0, skipped: 0, failed: 0 };
    if (!this.embedder) return report;
    const allRows = this.db
      .select()
      .from(schema.memories)
      .all();
    const rows = allRows.filter((r) => {
        const vec = decodeEmbedding(r.embedding);
        return !vec || r.embeddingSpace !== embeddingSpace(this.embedder!, vec.length);
      });
    report.inspected = allRows.length;
    report.needed = rows.length;
    report.skipped = allRows.length - rows.length;
    for (const r of rows) {
      try {
        const vec = toVector(await this.embedder.embed(r.content));
        const space = embeddingSpace(this.embedder, vec.length);
        const updated = this.writeMemory(() => {
          const current = this.readRow(r.id);
          // 等待端点期间的编辑/删除不能被旧内容的补算覆盖。
          if (!current || current.content !== r.content) return null;
          this.db.update(schema.memories)
            .set({ embedding: encodeEmbedding(vec), embeddingSpace: space })
            .where(eq(schema.memories.id, r.id)).run();
          return this.readRow(r.id) ?? null;
        }, (row) => { if (row) this.cacheRow(row); });
        if (updated) report.succeeded++;
        else report.skipped++;
      } catch {
        report.failed++;
      }
      report.processed++;
      onProgress?.(report.processed, rows.length);
    }
    return report;
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

  async scanMaintenance(options: MaintenanceScan = {}): Promise<MaintenanceSuggestions> {
    return suggestMaintenance(await this.exportAll(), options);
  }

  private maintenanceRows(ids: string[]): schema.SqliteMemoryRow[] {
    const rows = this.db.select().from(schema.memories).where(inArray(schema.memories.id, ids)).all();
    for (const row of rows) validateMemoryInput({ content: row.content, kind: row.kind, entities: JSON.parse(row.entities) });
    const byId = new Map(rows.map(row => [row.id, row]));
    return ids.flatMap(id => { const row = byId.get(id); return row ? [row] : []; });
  }

  async planMaintenance(raw: MaintenanceInput): Promise<MaintenancePlan> {
    const input = maintenanceInputSchema.parse(raw);
    return this.client.transaction(() => createMaintenancePlan(input, this.maintenanceRows(input.ids).map(row => this.toMemory(row)))).deferred();
  }

  async applyMaintenance(raw: MaintenancePlan, options: MaintenanceOptions): Promise<MaintenanceResult> {
    if (options.confirm !== true) throw Error("Maintenance requires explicit confirmation");
    const plan = maintenancePlanSchema.parse(raw), ids = plan.targets.map(target => target.id);
    let vec: Float32Array | null = null;
    if (plan.replacement && this.embedder) { try { vec = toVector(await this.embedder.embed(plan.replacement.content)); } catch { /* 降级为空向量，不能保留旧内容的向量。 */ } }
    const directory = options.backupDirectory ?? join(dirname(this.dbPath === ":memory:" ? defaultDbPath() : this.dbPath), "backups");
    const result = this.writeMemory(() => {
      const rows = this.maintenanceRows(ids), memories = rows.map(row => this.toMemory(row));
      validateMaintenanceSnapshot(plan, memories);
      const backup = writeMaintenanceBackup(directory, memories);
      const replacement = plan.replacement ? normalizeReplacement(plan.replacement, memories) : undefined;
      const kept = plan.replacement ? ids[0] : undefined, deletedIds = kept ? ids.slice(1) : ids;
      if (kept && replacement) {
        this.db.update(schema.memories).set({ ...replacement, entities: JSON.stringify(replacement.entities),
          embedding: vec ? encodeEmbedding(vec) : null, embeddingSpace: vec && this.embedder ? embeddingSpace(this.embedder, vec.length) : null, updatedAt: Date.now() }).where(eq(schema.memories.id, kept)).run();
        this.syncEdges(kept, replacement.entities ?? []);
      }
      this.db.delete(schema.memories).where(inArray(schema.memories.id, deletedIds)).run();
      this.db.delete(schema.entityNodes).where(sql`${schema.entityNodes.id} NOT IN (SELECT entity_id FROM memory_entity_edges)`).run();
      return { deleted: deletedIds.length, ...(kept ? { updated: kept } : {}), backup, keptRow: kept ? this.readRow(kept) : undefined };
    }, value => {
      for (const id of ids) { this.kwIndex?.remove(id); this.vecCache?.delete(id); }
      if (value.keptRow) this.cacheRow(value.keptRow);
    });
    const { keptRow, ...report } = result; return report;
  }

  async restoreMemories(items: Memory[], options: MaintenanceOptions): Promise<RestoreResult> {
    if (options.confirm !== true) throw Error("Restore requires explicit confirmation");
    validateRestoreItems(items);
    // 慢模型调用放在写锁之外，失败时用关键词检索，不能复用被覆盖内容的向量。
    const vectors = new Map<string, Float32Array>();
    if (this.embedder) for (const item of items) {
      try { const vec = toVector(await this.embedder.embed(item.content)); if (vec) vectors.set(item.id, vec); } catch { /* 降级，稍后可 reindex。 */ }
    }
    const directory = options.backupDirectory ?? join(dirname(this.dbPath === ":memory:" ? defaultDbPath() : this.dbPath), "backups");
    return this.writeMemory(() => {
      const existing = items.flatMap(item => { const row = this.readRow(item.id); return row ? [this.toMemory(row)] : []; });
      const backup = writeMaintenanceBackup(directory, existing);
      for (const item of items) {
        const vec = vectors.get(item.id), row = { id: item.id, content: item.content, kind: item.kind ?? "fact", source: item.source ?? "mcp",
          entities: JSON.stringify(item.entities ?? []), createdAt: item.createdAt, updatedAt: Date.now(),
          embedding: vec ? encodeEmbedding(vec) : null, embeddingSpace: vec && this.embedder ? embeddingSpace(this.embedder, vec.length) : null };
        this.db.insert(schema.memories).values(row).onConflictDoUpdate({ target: schema.memories.id, set: row }).run();
        this.syncEdges(item.id, item.entities ?? []);
      }
      this.db.delete(schema.entityNodes).where(sql`${schema.entityNodes.id} NOT IN (SELECT entity_id FROM memory_entity_edges)`).run();
      return { imported: items.length - existing.length, replaced: existing.length, backup };
    }, () => { this.kwIndex = null; this.vecCache = null; });
  }

  async importMemories(
    items: Memory[]
  ): Promise<{ imported: number; skipped: number }> {
    // 整批先校验，不能在遇到坏条目之前写入半份备份。
    items.forEach(item => validateRestoreItems([item]));
    const existing = new Set(this.db.select({ id: schema.memories.id }).from(schema.memories).all().map(row => row.id));
    const prepared: { item: Memory; vec: Float32Array | null }[] = [];
    for (const item of items) {
      if (existing.has(item.id)) continue;
      existing.add(item.id);
      let vec: Float32Array | null = null;
      if (this.embedder) {
        try {
          vec = toVector(await this.embedder.embed(item.content));
        } catch {
          // 与 save 同策略：embedding 失败按无向量落库
        }
      }
      prepared.push({ item, vec });
    }
    // 模型请求不持有写锁；一个事务与一个复用语句避免每条 fsync/prepare。
    // 并发新增编号仍保留对方已提交的内容，图谱故障则回滚整份导入。
    const insert = this.client.prepare("INSERT INTO memories (id, content, kind, source, entities, embedding, embedding_space, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING");
    try {
      return this.writeMemory(() => {
        let imported = 0;
        for (const { item, vec } of prepared) {
          const result = insert.run(item.id, item.content, item.kind ?? "fact", item.source ?? "mcp", JSON.stringify(item.entities ?? []),
            vec ? encodeEmbedding(vec) : null, vec && this.embedder ? embeddingSpace(this.embedder, vec.length) : null, item.createdAt, Date.now());
          if (result.changes) { this.syncEdges(item.id, item.entities ?? []); imported++; }
        }
        return { imported, skipped: items.length - imported };
      }, () => { if (prepared.length) { this.kwIndex = null; this.vecCache = null; } });
    } finally { insert.finalize(); }
  }
}
