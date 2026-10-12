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
} from "./memory";
import { validateMemoryInput } from "./memory-validation";
import { explainSearch, type SearchReport } from "./search-report";
import { KeywordIndex } from "./memory";

export type { Memory, MemoryStore } from "./memory";

/** 内存桩：不落盘，重启即清。仅测试 / 演示用。 */
export class StubStore implements MemoryStore {
  readonly backend = "stub";
  readonly retrieval = "keyword" as const;
  private rows = new Map<string, Memory>();
  private searches = 0;

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
    this.searches += 1;
    const index = new KeywordIndex(); index.rebuild([...this.rows.values()]);
    const ranked = index.rank(query, limit, m => matchesSearchScope(m, scope));
    return explainSearch(ranked.map(row => row.memory), ranked, [], { status: "disabled" }, []);
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
      zeroRecall: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
    };
  }

  async recentQueries(): Promise<[]> {
    return [];
  }

  async stats(): Promise<{ total: number; searches: number }> {
    return { total: this.rows.size, searches: this.searches };
  }

  // ---- v1.3 标注式评测（桩：无日志可标） ----

  async label(): Promise<void> {}

  async unlabel(): Promise<void> {}

  async getQuery(): Promise<null> {
    return null;
  }

  async unlabeledQueries(): Promise<[]> {
    return [];
  }

  async benchmark(): Promise<{
    labeledQueries: number;
    recall: number | null;
    precision: number | null;
  }> {
    return { labeledQueries: 0, recall: null, precision: null };
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
}

/** 工厂：stub 逃生口优先，否则 SQLite（库文件见 defaultDbPath） */
export function createStore(): MemoryStore {
  if (process.env.MEMOBOX_BACKEND === "stub") return new StubStore();
  return new SQLiteStore(undefined, defaultDbPath());
}
