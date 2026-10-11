/**
 * 存储入口（v2.0）：只留 SQLite（本地文件，零依赖）与 StubStore。
 * StubStore 给测试和 MEMOBOX_BACKEND=stub 的演示逃生口用。
 */
import { SQLiteStore } from "@/db/sqlite-store";
import { defaultDbPath } from "@/lib/paths";
import {
  scoreMemories,
  type Memory,
  type MemoryStore,
} from "./memory";

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

  async search(query: string, limit = 5): Promise<Memory[]> {
    this.searches += 1;
    return scoreMemories([...this.rows.values()], query, limit);
  }

  async list(limit: number): Promise<Memory[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async get(id: string): Promise<Memory | null> {
    return this.rows.get(id) ?? null;
  }

  async update(
    id: string,
    patch: { content?: string; kind?: string; entities?: string[] }
  ): Promise<Memory | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next: Memory = {
      ...row,
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.entities !== undefined ? { entities: patch.entities } : {}),
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
}

/** 工厂：stub 逃生口优先，否则 SQLite（库文件见 defaultDbPath） */
export function createStore(): MemoryStore {
  if (process.env.MEMOBOX_BACKEND === "stub") return new StubStore();
  return new SQLiteStore(undefined, defaultDbPath());
}
