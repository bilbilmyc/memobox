/**
 * Store selection: DATABASE_URL set → DrizzleStore (Postgres), otherwise
 * the in-memory StubStore keeps the app runnable without a database.
 */
import { DrizzleStore } from "@/db/store";
import {
  scoreMemories,
  type Memory,
  type MemoryStore,
} from "./memory";

export type { Memory, MemoryStore } from "./memory";

class StubStore implements MemoryStore {
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

  async recentQueries(): Promise<[]> {
    return [];
  }

  async stats(): Promise<{ total: number; searches: number }> {
    return { total: this.rows.size, searches: this.searches };
  }
}

export function createStore(): MemoryStore {
  return process.env.DATABASE_URL ? new DrizzleStore() : new StubStore();
}

const g = globalThis as unknown as { __memoboxStore?: MemoryStore };

export const memoryStore: MemoryStore = (g.__memoboxStore ??=
  createStore());
