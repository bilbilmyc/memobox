import { describe, expect, test } from "bun:test";
import { SQLiteStore } from "./sqlite-store";
import type { EmbeddingProvider } from "@/lib/embeddings";
import { computeBenchmark, cosineSim } from "@/lib/memory";

/** 与 pg 集成测试同款：确定性「词哈希袋」向量 */
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

describe("computeBenchmark（纯函数）", () => {
  test("recall 含漏检分母；precision 只看已标注召回项", () => {
    const b = computeBenchmark([
      {
        recalledIds: ["a", "b"],
        labels: [
          { memoryId: "a", relevant: true },
          { memoryId: "b", relevant: false },
          { memoryId: "c", relevant: true }, // 漏检：相关但未召回
        ],
      },
      {
        recalledIds: ["x"],
        labels: [{ memoryId: "x", relevant: true }], // recall 1, precision 1
      },
      {
        recalledIds: ["y"],
        labels: [], // 无标注，不计入
      },
    ]);
    expect(b.labeledQueries).toBe(2);
    expect(b.recall).toBeCloseTo((0.5 + 1) / 2);
    expect(b.precision).toBeCloseTo((0.5 + 1) / 2);
  });

  test("无任何标注返回 null", () => {
    const b = computeBenchmark([{ recalledIds: ["a"], labels: [] }]);
    expect(b.recall).toBeNull();
    expect(b.precision).toBeNull();
    expect(b.labeledQueries).toBe(0);
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

  test("graph expansion appends entity-linked memories", async () => {
    const store = new SQLiteStore(null, ":memory:");
    // 关键词只能直接命中第一条；第二条通过共享实体 payments 被图谱扩展带出
    await store.save({
      content: "quarterly invoice flow settled",
      entities: ["payments"],
      source: "test",
    });
    const linked = await store.save({
      content: "stripe webhook retries fixed",
      entities: ["payments"],
      source: "test",
    });
    const hits = await store.search("invoice", 5);
    expect(hits.length).toBe(2);
    expect(hits.some((h) => h.id === linked.id)).toBe(true);
  });

  test("update rewrites content/entities; forget cascades graph", async () => {
    const store = new SQLiteStore(null, ":memory:");
    const saved = await store.save({
      content: "before edit",
      entities: ["graph-cleanup-test"],
      source: "test",
    });

    const updated = await store.update(saved.id, {
      content: "after edit",
      entities: ["renamed-entity"],
    });
    expect(updated?.content).toBe("after edit");
    expect(updated?.entities).toEqual(["renamed-entity"]);
    // 实体榜应只剩新实体
    const entities = await store.topEntities(10);
    expect(entities).toEqual([{ name: "renamed-entity", memories: 1 }]);

    expect(await store.forget(saved.id)).toBe(true);
    expect(await store.get(saved.id)).toBeNull();
    // 遗忘后孤儿实体被清扫，实体榜清空
    expect(await store.topEntities(10)).toEqual([]);
    expect(await store.forget(saved.id)).toBe(false);
  });

  test("evalStats aggregates query log", async () => {
    const store = new SQLiteStore(null, ":memory:");
    await store.save({ content: "metrics anchor row", source: "test" });
    await store.search("metrics anchor", 5);
    await store.search("zzz-no-match-token", 5);
    const stats = await store.evalStats();
    expect(stats.totalQueries).toBe(2);
    expect(stats.zeroRecall).toBe(1);
    expect(stats.p50LatencyMs).toBeGreaterThanOrEqual(0);
    expect(stats.p95LatencyMs).toBeGreaterThanOrEqual(stats.p50LatencyMs);
  });

  test("labeling flow drives the benchmark (recall + missed relevant)", async () => {
    const store = new SQLiteStore(null, ":memory:");
    const m1 = await store.save({ content: "crimson kite festival", source: "test" });
    await store.save({ content: "meadow kite repair", source: "test" });
    await store.search("kite", 5); // 召回两条含 kite 的记忆

    const entry = (await store.recentQueries(1))[0];
    expect(entry.recalled).toBe(2);
    expect(entry.relevantIds).toEqual([]);

    await store.label(entry.id, m1.id, true); // 相关
    await store.label(entry.id, m1.id, true); // 幂等：重复标注不产生新行
    const labeled = (await store.recentQueries(1))[0];
    expect(labeled.relevantIds).toEqual([m1.id]);

    let bench = await store.benchmark();
    expect(bench.labeledQueries).toBe(1);
    expect(bench.recall).toBe(1); // 相关集 = 召回集内
    expect(bench.precision).toBe(1);

    // 补充漏检：相关但当时没被召回 → recall 掉到 0.5
    const missed = await store.save({ content: "kite string tension notes", source: "test" });
    await store.label(entry.id, missed.id, true);
    bench = await store.benchmark();
    expect(bench.recall).toBeCloseTo(0.5);

    // 撤销补充 → 恢复
    await store.unlabel(entry.id, missed.id);
    bench = await store.benchmark();
    expect(bench.recall).toBe(1);

    // getQuery 还原召回顺序与标注
    const data = await store.getQuery(entry.id);
    expect(data?.recalled.length).toBe(2);
    expect(data?.labels).toEqual([{ memoryId: m1.id, relevant: true }]);

    // 新查询进入待标注队列，已标注的不在
    await store.search("metrics", 5);
    const queue = await store.unlabeledQueries(10);
    expect(queue.length).toBe(1);
    expect(queue[0].query).toBe("metrics");
  });
});
