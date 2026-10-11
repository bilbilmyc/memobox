/**
 * 记忆领域类型 + 共享的打分/图谱工具函数。独立于各 store 实现，
 * 避免相互 import 成环。
 */

export type Memory = {
  id: string;
  content: string;
  kind?: string;
  entities?: string[];
  source?: string;
  createdAt: number;
};

export type QueryLogEntry = {
  id: string;
  query: string;
  recalled: number;
  latencyMs: number | null;
  createdAt: number;
};

export type EntityCount = { name: string; memories: number };

export type EvalStats = {
  totalQueries: number;
  zeroRecall: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
};

export interface MemoryStore {
  readonly backend: string;
  readonly retrieval: "semantic" | "keyword";
  save(input: {
    content: string;
    kind?: string;
    entities?: string[];
    source?: string;
  }): Promise<Memory>;
  search(query: string, limit?: number): Promise<Memory[]>;
  list(limit: number): Promise<Memory[]>;
  recentQueries(limit?: number): Promise<QueryLogEntry[]>;
  stats(): Promise<{ total: number; searches: number }>;
  get(id: string): Promise<Memory | null>;
  update(
    id: string,
    patch: { content?: string; kind?: string; entities?: string[] }
  ): Promise<Memory | null>;
  forget(id: string): Promise<boolean>;
  topEntities(limit?: number): Promise<EntityCount[]>;
  evalStats(): Promise<EvalStats>;
}

/** 余弦相似度：本地模式（SQLite）的向量检索用 */
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm === 0 ? 0 : dot / norm;
}

/** 朴素关键词打分 —— 回退检索模式（v0.2 起用） */
export function scoreMemories(
  rows: Memory[],
  query: string,
  limit: number
): Memory[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .map((row) => {
      const text = row.content.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (text.includes(t)) score += 2;
        if (row.entities?.some((e) => e.toLowerCase().includes(t))) score += 1;
      }
      return { row, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.row.createdAt - a.row.createdAt)
    .slice(0, limit)
    .map((r) => r.row);
}

/**
 * 图谱扩展（v1.2）：用与直接命中共享实体的记忆补满剩余名额；
 * 直接检索空手而归时，锚点退化为查询词本身（实体即检索入口）。
 * candidates 须已含至少一个锚点实体；按共享实体数排序，其次按时间。
 */
export function expandByEntities(
  candidates: Memory[],
  primary: Memory[],
  anchors: string[],
  limit: number
): Memory[] {
  const slots = limit - primary.length;
  if (slots <= 0 || anchors.length === 0) return [];
  const anchorSet = new Set(anchors.map((a) => a.toLowerCase()));
  const taken = new Set(primary.map((h) => h.id));
  return candidates
    .filter((c) => !taken.has(c.id))
    .map((c) => ({
      c,
      shared: (c.entities ?? []).filter((e) => anchorSet.has(e.toLowerCase()))
        .length,
    }))
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || b.c.createdAt - a.c.createdAt)
    .slice(0, slots)
    .map((x) => x.c);
}

/** 最近邻排名百分位（入参须升序） */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(idx, sortedAsc.length - 1))];
}
