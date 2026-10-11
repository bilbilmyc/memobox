/**
 * Pluggable memory store.
 *
 * StubStore keeps the skeleton fully runnable without Postgres (naive
 * keyword scoring, in-memory, survives HMR via globalThis). The next
 * milestone swaps in a DrizzleStore backed by pgvector + the reserved
 * entity-graph tables — implement the same interface and replace the
 * singleton below.
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

class StubStore implements MemoryStore {
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
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.rows.values()]
      .map((row) => {
        const text = row.content.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (text.includes(t)) score += 2;
          score += row.entities?.some((e) => e.toLowerCase().includes(t))
            ? 1
            : 0;
        }
        return { row, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.row.createdAt - a.row.createdAt)
      .slice(0, limit)
      .map((r) => r.row);
  }

  async list(limit: number): Promise<Memory[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async stats(): Promise<{ total: number; searches: number }> {
    return { total: this.rows.size, searches: this.searches };
  }
}

const g = globalThis as unknown as { __memoboxStore?: MemoryStore };

export const memoryStore: MemoryStore = (g.__memoboxStore ??= new StubStore());
