/**
 * Memory domain types + shared keyword scoring. Lives apart from the store
 * implementations so they can depend on it without import cycles.
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
}

/** Cosine similarity for local-mode (SQLite) vector search. */
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

/** Naive keyword scoring — the fallback retrieval mode (v0.2). */
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
