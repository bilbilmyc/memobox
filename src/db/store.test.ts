import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DrizzleStore } from "./store";
import { getDb } from "./index";
import { memories, queryLog } from "./schema";
import type { EmbeddingProvider } from "@/lib/embeddings";

/**
 * 对 .env 里真实 Postgres 的集成测试（docker compose up -d）。
 * 未配 DATABASE_URL 时整体跳过。
 */
const dbAvailable = Boolean(process.env.DATABASE_URL);
const maybe = dbAvailable ? test : test.skip;

const store = new DrizzleStore();
const TAG = "test-integration";

/** 确定性「词哈希袋」1536 维向量，语义测试专用 */
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

// 文件级 afterAll：describe 内注册只会在该 describe 结束时触发，
// 后跑的 describe 写入的行就漏掉了（v1.2 踩过：TAG 行残留）
afterAll(async () => {
  if (!dbAvailable) return;
  await getDb().delete(memories).where(eq(memories.source, TAG));
  for (const q of [
    "test-integration-query",
    "aurora borealis lights phenomena",
    "vivid dune lantern",
    "graph governance probe row alpha",
    "persistence",
    "lantern harbor benchmark probe",
  ]) {
    await getDb().delete(queryLog).where(eq(queryLog.query, q));
  }
});

describe("DrizzleStore", () => {

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

describe("DrizzleStore graph + governance (live Postgres)", () => {
  maybe("save syncs entity edges; topEntities counts them", async () => {
    const store = new DrizzleStore(null);
    await store.save({
      content: "graph governance probe row alpha",
      entities: ["graph-gov-probe", "shared-anchor"],
      source: TAG,
    });
    await store.save({
      content: "graph governance probe row beta",
      entities: ["graph-gov-probe"],
      source: TAG,
    });
    const entities = await store.topEntities(50);
    const probe = entities.find((e) => e.name === "graph-gov-probe");
    expect(probe?.memories).toBe(2);
  });

  maybe("graph expansion appends entity-linked memories", async () => {
    const store = new DrizzleStore(null);
    // 关键词只能直接命中第一条；第二条与查询词零重叠，
    // 仅靠共享实体被图谱扩展带出（措辞刻意避开其他用例的词）
    const linked = await store.save({
      content: "mellow cactus telegram",
      entities: ["expansion-anchor-v2"],
      source: TAG,
    });
    await store.save({
      content: "vivid dune lantern",
      entities: ["expansion-anchor-v2"],
      source: TAG,
    });
    const hits = await store.search("vivid dune lantern", 5);
    expect(hits.length).toBe(2);
    expect(hits.some((h) => h.id === linked.id)).toBe(true);
  });

  maybe("update rewrites content; forget cascades and sweeps orphans", async () => {
    const store = new DrizzleStore(null);
    const saved = await store.save({
      content: "governance edit target row",
      entities: ["gov-edit-probe"],
      source: TAG,
    });

    const updated = await store.update(saved.id, {
      content: "governance edited content",
      entities: ["gov-edit-probe-2"],
    });
    expect(updated?.content).toBe("governance edited content");
    expect(updated?.entities).toEqual(["gov-edit-probe-2"]);

    expect(await store.forget(saved.id)).toBe(true);
    expect(await store.get(saved.id)).toBeNull();
    // 孤儿实体应已被清扫
    const entities = await store.topEntities(100);
    expect(entities.find((e) => e.name === "gov-edit-probe-2")).toBeUndefined();
    expect(await store.forget(saved.id)).toBe(false);
  });

  maybe("evalStats aggregates the query log", async () => {
    const store = new DrizzleStore(null);
    const stats = await store.evalStats();
    expect(stats.totalQueries).toBeGreaterThanOrEqual(1);
    expect(stats.zeroRecall).toBeLessThanOrEqual(stats.totalQueries);
    expect(stats.p50LatencyMs).toBeGreaterThanOrEqual(0);
    expect(stats.p95LatencyMs).toBeGreaterThanOrEqual(stats.p50LatencyMs);
  });
});

describe("DrizzleStore labeling + benchmark (live Postgres)", () => {
  const QUERY = "lantern harbor benchmark probe";

  maybe("label/unlabel round-trip moves the benchmark", async () => {
    const store = new DrizzleStore(null);
    const hit = await store.save({
      content: "lantern harbor benchmark probe hit row",
      source: TAG,
    });
    await store.save({
      content: "lantern harbor benchmark probe miss row",
      source: TAG,
    });
    await store.search(QUERY, 5); // 关键词召回两条

    const entry = (await store.recentQueries(1))[0];
    // 库里还有其他用例未清理的 lantern 行 + 图谱扩展会多带几条，只断言下限
    expect(entry.recalled).toBeGreaterThanOrEqual(2);

    await store.label(entry.id, hit.id, true);
    let bench = await store.benchmark();
    expect(bench.labeledQueries).toBeGreaterThanOrEqual(1);
    expect(bench.recall).toBe(1);

    // recentQueries 带出已标相关的记忆 id（回归：子查询列遮蔽曾让它恒空）
    expect((await store.recentQueries(1))[0].relevantIds).toContain(hit.id);

    // 撤销后这条查询回到无标注状态
    await store.unlabel(entry.id, hit.id);
    const queue = await store.unlabeledQueries(5);
    expect(queue.some((q) => q.id === entry.id)).toBe(true);

    const data = await store.getQuery(entry.id);
    expect(data?.entry.query).toBe(QUERY);
    expect(data?.recalled.length).toBeGreaterThanOrEqual(2);
    expect(data?.labels).toEqual([]);
  });
});
