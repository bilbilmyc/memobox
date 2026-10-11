import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SQLiteStore } from "./sqlite-store";
import type { EmbeddingProvider } from "@/lib/embeddings";
import { computeBenchmark, cosineSim } from "@/lib/memory";
import { buildBackup, parseBackup } from "@/lib/backup";

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

describe("SQLiteStore 备份/迁移 (v1.6)", () => {
  test("exportAll 按创建时间升序", async () => {
    const a = new SQLiteStore(null, ":memory:");
    // 用导入造出乱序时间——同毫秒连续 save 分不出先后
    await a.importMemories([
      { id: "x3", content: "c3", createdAt: 5 },
      { id: "x1", content: "c1", createdAt: 1 },
      { id: "x2", content: "c2", createdAt: 3 },
    ]);
    const backup = buildBackup(await a.exportAll());
    expect(backup.memories.map((m) => m.id)).toEqual(["x1", "x2", "x3"]);
  });

  test("跨库导入保留 id/时间/实体，重复导入全跳过", async () => {
    // 库 A：常规 save 三条（模拟生产库）
    const a = new SQLiteStore(null, ":memory:");
    const m2 = await a.save({ content: "second entry", entities: ["memobox", "soren"] });
    await a.save({ content: "first entry", entities: ["memobox"] });
    await a.save({ content: "third entry" });

    const backup = buildBackup(await a.exportAll());
    expect(backup.memories).toHaveLength(3);

    // 库 B：解析备份文件后整体导入（模拟 SQLite→pg 换库迁移）
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const b = new SQLiteStore(null, ":memory:");
    const r1 = await b.importMemories(parsed.items);
    expect(r1).toEqual({ imported: 3, skipped: 0 });

    // id / createdAt / 实体原样保留
    const list = await b.list(10);
    expect(list).toHaveLength(3);
    const withEntities = list.find((m) => m.id === m2.id)!;
    expect(withEntities.entities).toEqual(["memobox", "soren"]);
    expect(withEntities.createdAt).toBe(m2.createdAt);

    // 图谱边也长出来了
    const entities = await b.topEntities();
    expect(entities).toContainEqual({ name: "memobox", memories: 2 });
    expect(entities).toContainEqual({ name: "soren", memories: 1 });

    // 同一备份再导一次：id 冲突全跳过，不覆盖
    const r2 = await b.importMemories(parsed.items);
    expect(r2).toEqual({ imported: 0, skipped: 3 });
    expect((await b.stats()).total).toBe(3);
  });

  test("带 fake embedder 的库导入时向量现算，检索可用", async () => {
    const a = new SQLiteStore(null, ":memory:");
    await a.save({ content: "aurora lights over the harbor" });
    const parsed = parseBackup(
      JSON.stringify(buildBackup(await a.exportAll()))
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // 目标库语义模式：导入后关键词即语义命中
    const b = new SQLiteStore(fakeEmbedder(), ":memory:");
    await b.importMemories(parsed.items);
    const hits = await b.search("aurora", 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].content).toContain("aurora");
  });
});

describe("SQLiteStore v2.6：BLOB 向量 + 混合检索 + 进程内缓存", () => {
  test("向量以 Float32 BLOB 落库；旧 JSON 文本重开时自动迁移", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memobox-v26-"));
    const dbPath = join(dir, "t.db");
    const store = new SQLiteStore(fakeEmbedder(), dbPath);
    let store2: SQLiteStore | null = null;
    try {
      // 新库：save 直接写 BLOB
      await store.save({ content: "legacy migration anchor row", source: "test" });
      const probe = new Database(dbPath);
      expect(
        (
          probe
            .query("SELECT typeof(embedding) AS t FROM memories")
            .all() as { t: string }[]
        )[0].t
      ).toBe("blob");
      probe.close();

      // 仿造 v2.5 旧格式：把向量改写成 JSON 文本
      const writer = new Database(dbPath);
      writer.exec("UPDATE memories SET embedding = '[0.5,0.5,0.5,0.5]'");
      writer.close();

      // 重开 → 构造函数迁移为 BLOB，检索照常
      store2 = new SQLiteStore(fakeEmbedder(), dbPath);
      const probe2 = new Database(dbPath);
      expect(
        (
          probe2
            .query("SELECT typeof(embedding) AS t FROM memories")
            .all() as { t: string }[]
        )[0].t
      ).toBe("blob");
      probe2.close();
      const hits = await store2.search("legacy migration anchor", 5);
      expect(hits.length).toBeGreaterThanOrEqual(1);
    } finally {
      // Windows：句柄关闭后目录项可能延迟释放，重试几下再兜底放过
      store.close();
      store2?.close();
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 30));
        }
      }
    }
  });

  test("混合检索：关键词命中的与语义命中的都进结果（RRF 融合）", async () => {
    // 桩 embedder：查询 semaphore → [1,0]；含「向量」的文本 → [1,0]；其余 → [0,1]
    const stub: EmbeddingProvider = {
      model: "stub",
      dimensions: 2,
      async embed(text: string) {
        if (text === "semaphore") return [1, 0];
        return text.includes("向量") ? [1, 0] : [0, 1];
      },
    };
    const store = new SQLiteStore(stub, ":memory:");
    const semOnly = await store.save({ content: "向量检索的底层原理速记", source: "test" });
    const kwOnly = await store.save({ content: "docker semaphore 速查表", source: "test" });
    // 「semaphore」：关键词只命中 kwOnly，余弦只把 semOnly 排前——两路互补都进榜
    const hits = await store.search("semaphore", 2);
    expect(new Set(hits.map((h) => h.id))).toEqual(
      new Set([semOnly.id, kwOnly.id])
    );
    expect(hits[0].id).toBe(kwOnly.id); // 双路得分者第一
  });

  test("向量缓存随 update 失效，不留过期向量", async () => {
    const stub: EmbeddingProvider = {
      model: "stub",
      dimensions: 2,
      async embed(text: string) {
        if (text === "alpha topic" || text === "query") return [1, 0];
        return [0, 1];
      },
    };
    const store = new SQLiteStore(stub, ":memory:");
    // 显式 createdAt 造数：同毫秒 save 的并列会破坏排序断言
    await store.importMemories([
      { id: "alpha", content: "alpha topic", createdAt: 10 }, // 向量 [1,0]
      { id: "newer", content: "gamma filler", createdAt: 20 }, // 向量 [0,1]
    ]);
    expect((await store.search("query", 5))[0].id).toBe("alpha");

    await store.update("alpha", { content: "beta topic" }); // 新向量 [0,1]
    const after = await store.search("query", 5);
    // 缓存若过期：alpha 仍 sim=1 会霸榜；正确时应平分后按时间 newer 先
    expect(after[0].id).toBe("newer");
  });

  test("关键词索引增量维护：save 后立即可查，forget 后立即消失", async () => {
    const store = new SQLiteStore(null, ":memory:");
    await store.save({ content: "initial anchor row", source: "test" });
    await store.search("anchor", 5); // 触发建索引
    const later = await store.save({ content: "zebra crossing added later", source: "test" });
    expect((await store.search("zebra", 5)).some((h) => h.id === later.id)).toBe(true);
    await store.forget(later.id);
    expect(await store.search("zebra", 5)).toHaveLength(0);
  });
});
