import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DrizzleStore } from "./store";
import { getDb } from "./index";
import { memories, queryLog } from "./schema";
import type { EmbeddingProvider } from "@/lib/embeddings";

/**
 * Integration tests against the real Postgres from .env
 * (docker compose up -d). Skipped when DATABASE_URL is not set.
 */
const dbAvailable = Boolean(process.env.DATABASE_URL);
const maybe = dbAvailable ? test : test.skip;

const store = new DrizzleStore();
const TAG = "test-integration";

/** Deterministic bag-of-hashed-words 1536-dim vectors for semantic tests. */
function fakeEmbedder(): EmbeddingProvider {
  return {
    model: "fake-hash",
    dimensions: 1536,
    async embed(text: string) {
      const vec = new Array<number>(1536).fill(0);
      for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (!word) continue;
        let h = 0;
        for (let i = 0; i < word.length; i++) {
          h = (h * 31 + word.charCodeAt(i)) >>> 0;
        }
        vec[h % 1536] += 1;
      }
      return vec;
    },
  };
}

describe("DrizzleStore", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await getDb().delete(memories).where(eq(memories.source, TAG));
    await getDb()
      .delete(queryLog)
      .where(eq(queryLog.query, "test-integration-query"));
    await getDb()
      .delete(queryLog)
      .where(eq(queryLog.query, "aurora borealis lights phenomena"));
  });

  maybe("save persists and returns the row", async () => {
    const row = await store.save({
      content: "integration test memory about memobox persistence",
      kind: "fact",
      entities: ["memobox"],
      source: TAG,
    });
    expect(row.id).toMatch(/[0-9a-f-]{36}/);
    expect(row.content).toContain("persistence");
  });

  maybe("search finds saved rows by keyword", async () => {
    const hits = await store.search("persistence", 5);
    expect(hits.some((h) => h.source === TAG)).toBe(true);
  });

  maybe("search writes query_log entries", async () => {
    const before = await store.stats();
    await store.search("test-integration-query", 3);
    const after = await store.stats();
    expect(after.searches).toBe(before.searches + 1);
  });

  maybe("stats counts memories", async () => {
    const s = await store.stats();
    expect(s.total).toBeGreaterThanOrEqual(1);
  });

  maybe("list returns recent rows", async () => {
    const rows = await store.list(10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].createdAt).toBeGreaterThan(0);
  });
});

describe("DrizzleStore semantic (fake embedder + live pgvector)", () => {
  const semantic = new DrizzleStore(fakeEmbedder());

  maybe("reports semantic retrieval mode", () => {
    expect(semantic.retrieval).toBe("semantic");
    expect(store.retrieval).toBe(
      process.env.EMBEDDING_API_BASE ? "semantic" : "keyword"
    );
  });

  maybe("saves rows with embeddings and ranks by cosine distance", async () => {
    const near = await semantic.save({
      content: "aurora borealis northern lights phenomena",
      source: TAG,
    });
    const far = await semantic.save({
      content: "docker container orchestration platform",
      source: TAG,
    });
    expect(near.id).not.toBe(far.id);

    // Vectors actually landed in the vector(1536) column.
    const embedded = await getDb()
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.id, near.id));
    expect(embedded.length).toBe(1);

    const hits = await semantic.search(
      "aurora borealis lights phenomena",
      5
    );
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].id).toBe(near.id);
    expect(hits.find((h) => h.id === far.id)).toBeDefined(); // orthogonal but still ranked
  });

  maybe("recentQueries returns logged entries", async () => {
    await semantic.search("aurora borealis lights phenomena", 3);
    const recent = await semantic.recentQueries(10);
    expect(recent.length).toBeGreaterThanOrEqual(1);
    expect(recent[0].query).toBe("aurora borealis lights phenomena");
    expect(recent[0].recalled).toBeGreaterThanOrEqual(1);
    expect(typeof recent[0].latencyMs).toBe("number");
  });
});
