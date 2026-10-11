import { describe, expect, test } from "bun:test";
import { SQLiteStore } from "./sqlite-store";
import type { EmbeddingProvider } from "@/lib/embeddings";
import { cosineSim } from "@/lib/memory";

/** Same deterministic bag-of-hashed-words vectors as the pg integration tests. */
function fakeEmbedder(dim = 64): EmbeddingProvider {
  return {
    model: "fake-hash",
    dimensions: dim,
    async embed(text: string) {
      const vec = new Array<number>(dim).fill(0);
      for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (!word) continue;
        let h = 0;
        for (let i = 0; i < word.length; i++) {
          h = (h * 31 + word.charCodeAt(i)) >>> 0;
        }
        vec[h % dim] += 1;
      }
      return vec;
    },
  };
}

describe("cosineSim", () => {
  test("identical vectors → 1, orthogonal → 0", () => {
    expect(cosineSim([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSim([0, 0], [1, 1])).toBe(0); // zero-vector guard
  });
});

describe("SQLiteStore (in-memory)", () => {
  test("keyword mode: save → search → stats → recentQueries round-trip", async () => {
    const store = new SQLiteStore(null, ":memory:");
    expect(store.backend).toBe("sqlite");
    expect(store.retrieval).toBe("keyword");

    const saved = await store.save({
      content: "soren prefers tabs over spaces",
      kind: "preference",
      entities: ["soren"],
      source: "test",
    });
    expect(saved.id).toMatch(/[0-9a-f-]{36}/);

    const hits = await store.search("tabs spaces", 5);
    expect(hits.some((h) => h.id === saved.id)).toBe(true);

    const stats = await store.stats();
    expect(stats.total).toBe(1);
    expect(stats.searches).toBeGreaterThanOrEqual(1);

    const queries = await store.recentQueries(5);
    expect(queries[0].query).toBe("tabs spaces");
    expect(queries[0].recalled).toBeGreaterThanOrEqual(1);
    expect(typeof queries[0].latencyMs).toBe("number");
  });

  test("semantic mode: cosine ranking with fake embeddings", async () => {
    const store = new SQLiteStore(fakeEmbedder(), ":memory:");
    expect(store.retrieval).toBe("semantic");

    const near = await store.save({
      content: "aurora borealis northern lights phenomena",
      source: "test",
    });
    const far = await store.save({
      content: "docker container orchestration platform",
      source: "test",
    });

    const hits = await store.search("aurora borealis lights phenomena", 5);
    expect(hits.length).toBe(2);
    expect(hits[0].id).toBe(near.id);
    expect(hits[1].id).toBe(far.id); // orthogonal but still listed
  });

  test("search with no matches returns empty, not an error", async () => {
    const store = new SQLiteStore(null, ":memory:");
    await store.save({ content: "unrelated content here", source: "test" });
    const hits = await store.search("zzz-no-match-token", 5);
    expect(hits).toEqual([]);
  });
});
