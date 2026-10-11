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

export interface MemoryStore {
  readonly backend: string;
  save(input: {
    content: string;
    kind?: string;
    entities?: string[];
    source?: string;
  }): Promise<Memory>;
  search(query: string, limit?: number): Promise<Memory[]>;
  list(limit: number): Promise<Memory[]>;
  stats(): Promise<{ total: number; searches: number }>;
}

/** Naive keyword scoring shared by the stub and postgres backends (v0.2). */
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
