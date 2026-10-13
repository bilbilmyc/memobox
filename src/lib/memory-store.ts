/**
 * 存储入口（v2.0）：只留 SQLite（本地文件，零依赖）与 StubStore。
 * StubStore 给测试和 MEMOBOX_BACKEND=stub 的演示逃生口用。
 */
import { SQLiteStore } from "@/db/sqlite-store";
import { defaultDbPath } from "@/lib/paths";
import {
  matchesSearchScope,
  type Memory,
  type MemoryStore,
  type MemoryQuery,
  type SearchScope,
  type BackfillReport,
  type QueryReview,
  type QueryLogEntry,
  computeBenchmark,
  percentile,
} from "./memory";
import { validateMemoryInput } from "./memory-validation";
import { FeedbackError } from "./feedback";
import { explainSearch, type SearchReport } from "./search-report";
import { KeywordIndex } from "./memory";
import { dirname, join } from "node:path";
import { createMaintenancePlan, suggestMaintenance, maintenancePlanSchema, validateMaintenanceSnapshot, writeMaintenanceBackup, normalizeReplacement, validateRestoreItems,
  type MaintenanceInput, type MaintenancePlan, type MaintenanceScan, type MaintenanceOptions, type MaintenanceResult, type RestoreResult } from "./maintenance";

export type { Memory, MemoryStore } from "./memory";

/** 内存桩：不落盘，重启即清。仅测试 / 演示用。 */
export class StubStore implements MemoryStore {
  readonly backend = "stub";
  readonly retrieval = "keyword" as const;
  private rows = new Map<string, Memory>();
  private searches = 0;
  private logs = new Map<string, { entry: QueryLogEntry; recalledIds: string[]; labels: Map<string, boolean> }>();

  async save(input: {
    content: string;
    kind?: string;
    entities?: string[];
    source?: string;
  }): Promise<Memory> {
    validateMemoryInput(input);
    const id = crypto.randomUUID().slice(0, 8);
    const row: Memory = {
      id,
      content: input.content,
      kind: input.kind,
      entities: input.entities,
      source: input.source,
      createdAt: Date.now(),
    };
    this.rows.set(id, row);
    return row;
  }

  async search(query: string, limit = 5, scope: SearchScope = {}): Promise<Memory[]> {
    return (await this.searchDetailed(query, limit, scope)).memories;
  }

  async searchDetailed(query: string, limit = 5, scope: SearchScope = {}): Promise<SearchReport> {
    const started = Date.now();
    this.searches += 1;
    const index = new KeywordIndex(); index.rebuild([...this.rows.values()]);
    const ranked = index.rank(query, limit, m => matchesSearchScope(m, scope));
    const report = explainSearch(ranked.map(row => row.memory), ranked, [], { status: "disabled" }, []);
    const queryId = crypto.randomUUID();
    this.logs.set(queryId, { entry: { id: queryId, query, recalled: report.memories.length, latencyMs: Date.now() - started, createdAt: Date.now() },
      recalledIds: report.memories.map(row => row.id), labels: new Map() });
    return { ...report, queryId };
  }

  async list(limit: number): Promise<Memory[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async get(id: string): Promise<Memory | null> {
    return this.rows.get(id) ?? null;
  }

  async query(filters: MemoryQuery): Promise<Memory[]> {
    let rows = [...this.rows.values()].filter(m =>
      (!filters.text || m.content.toLowerCase().includes(filters.text.toLowerCase())) &&
      (!filters.kind || (m.kind ?? "fact") === filters.kind) &&
      (!filters.source || m.source === filters.source) &&
      (!filters.entity || (m.entities ?? []).some(e => e.toLowerCase() === filters.entity!.toLowerCase())) &&
      (filters.since === undefined || m.createdAt >= filters.since));
    rows.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return rows.slice(filters.offset ?? 0, (filters.offset ?? 0) + (filters.limit ?? 20));
  }

  async update(
    id: string,
    patch: { content?: string; kind?: string; entities?: string[]; source?: string }
  ): Promise<Memory | null> {
    validateMemoryInput(patch, false);
    const row = this.rows.get(id);
    if (!row) return null;
    const next: Memory = {
      ...row,
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.entities !== undefined ? { entities: patch.entities } : {}),
      ...(patch.source !== undefined ? { source: patch.source } : {}),
    };
    this.rows.set(id, next);
    return next;
  }

  async forget(id: string): Promise<boolean> {
    for (const log of this.logs.values()) log.labels.delete(id);
    return this.rows.delete(id);
  }

  async topEntities(): Promise<[]> {
    return [];
  }

  async evalStats(): Promise<{
    totalQueries: number;
    zeroRecall: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
  }> {
    return {
      totalQueries: this.searches,
      zeroRecall: [...this.logs.values()].filter(log => !log.recalledIds.length).length,
      p50LatencyMs: percentile([...this.logs.values()].map(log => log.entry.latencyMs ?? 0).sort((a, b) => a - b), 50),
      p95LatencyMs: percentile([...this.logs.values()].map(log => log.entry.latencyMs ?? 0).sort((a, b) => a - b), 95),
    };
  }

  async recentQueries(limit = 10): Promise<QueryLogEntry[]> {
    return [...this.logs.values()].sort((a, b) => b.entry.createdAt - a.entry.createdAt || b.entry.id.localeCompare(a.entry.id))
      .slice(0, limit).map(log => ({ ...log.entry, relevantIds: [...log.labels].filter(([, relevant]) => relevant).map(([id]) => id) }));
  }

  async stats(): Promise<{ total: number; searches: number }> {
    return { total: this.rows.size, searches: this.searches };
  }

  // 桩和 SQLite 使用相同反馈语义，测试不能把静默空实现当作成功。

  async label(queryLogId: string, memoryId: string, relevant: boolean): Promise<void> {
    const log = this.logs.get(queryLogId);
    if (!log) throw new FeedbackError("query_missing");
    if (!this.rows.has(memoryId)) throw new FeedbackError("memory_missing");
    if (!relevant && !log.recalledIds.includes(memoryId)) throw new FeedbackError("not_recalled");
    log.labels.set(memoryId, relevant);
  }

  async unlabel(queryLogId: string, memoryId: string): Promise<void> {
    const log = this.logs.get(queryLogId);
    if (!log) throw new FeedbackError("query_missing");
    log.labels.delete(memoryId);
  }

  async getQuery(id: string): Promise<QueryReview | null> {
    const log = this.logs.get(id);
    return log ? { entry: { ...log.entry }, recalledIds: [...log.recalledIds],
      recalled: log.recalledIds.flatMap(id => this.rows.has(id) ? [this.rows.get(id)!] : []),
      labels: [...log.labels].map(([memoryId, relevant]) => ({ memoryId, relevant })) } : null;
  }

  async unlabeledQueries(limit = 20): Promise<QueryLogEntry[]> {
    return [...this.logs.values()].filter(log => !log.labels.size)
      .sort((a, b) => b.entry.createdAt - a.entry.createdAt || b.entry.id.localeCompare(a.entry.id))
      .slice(0, limit).map(log => ({ ...log.entry }));
  }

  async benchmark(): Promise<{
    labeledQueries: number;
    recall: number | null;
    precision: number | null;
  }> {
    return computeBenchmark([...this.logs.values()].map(log => ({ recalledIds: log.recalledIds,
      labels: [...log.labels].map(([memoryId, relevant]) => ({ memoryId, relevant })) })));
  }

  // ---- v1.6 备份/迁移 ----

  async exportAll(): Promise<Memory[]> {
    return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async importMemories(
    items: Memory[]
  ): Promise<{ imported: number; skipped: number }> {
    items.forEach(item => validateMemoryInput(item));
    let imported = 0;
    let skipped = 0;
    for (const item of items) {
      if (this.rows.has(item.id)) {
        skipped++;
        continue;
      }
      this.rows.set(item.id, { ...item });
      imported++;
    }
    return { imported, skipped };
  }

  /** 桩不存向量，补算恒为 0 */
  async backfillEmbeddings(): Promise<BackfillReport> {
    return { inspected: 0, needed: 0, processed: 0, succeeded: 0, skipped: 0, failed: 0 };
  }

  async scanMaintenance(options: MaintenanceScan = {}) { return suggestMaintenance([...this.rows.values()], options); }
  async planMaintenance(input: MaintenanceInput) { return createMaintenancePlan(input, [...this.rows.values()]); }
  async applyMaintenance(raw: MaintenancePlan, options: MaintenanceOptions): Promise<MaintenanceResult> {
    if (options.confirm !== true) throw Error("Maintenance requires explicit confirmation");
    const plan = maintenancePlanSchema.parse(raw), rows = plan.targets.flatMap(target => { const row = this.rows.get(target.id); return row ? [row] : []; });
    validateMaintenanceSnapshot(plan, rows);
    const backup = writeMaintenanceBackup(options.backupDirectory ?? join(dirname(defaultDbPath()), "backups"), rows);
    if (plan.replacement) this.rows.set(rows[0].id, { ...rows[0], ...normalizeReplacement(plan.replacement, rows) });
    const deleted = plan.replacement ? rows.slice(1) : rows;
    for (const row of deleted) { this.rows.delete(row.id); for (const log of this.logs.values()) log.labels.delete(row.id); }
    return { deleted: deleted.length, ...(plan.replacement ? { updated: rows[0].id } : {}), backup };
  }
  async restoreMemories(items: Memory[], options: MaintenanceOptions): Promise<RestoreResult> {
    if (options.confirm !== true) throw Error("Restore requires explicit confirmation");
    validateRestoreItems(items);
    const existing = items.flatMap(item => { const row = this.rows.get(item.id); return row ? [row] : []; });
    const backup = writeMaintenanceBackup(options.backupDirectory ?? join(dirname(defaultDbPath()), "backups"), existing);
    for (const item of items) this.rows.set(item.id, { ...item, kind: item.kind ?? "fact", source: item.source ?? "mcp", entities: item.entities ?? [] });
    return { imported: items.length - existing.length, replaced: existing.length, backup };
  }
}

/** 工厂：stub 逃生口优先，否则 SQLite（库文件见 defaultDbPath） */
export function createStore(): MemoryStore {
  if (process.env.MEMOBOX_BACKEND === "stub") return new StubStore();
  return new SQLiteStore(undefined, defaultDbPath());
}
