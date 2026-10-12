import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { EmbeddingProvider } from "@/lib/embeddings";
import { cosineSim } from "@/lib/memory";
import { SQLiteStore } from "./sqlite-store";

/** 每个场景使用独立临时库；不读取用户配置或下载模型。 */
async function withDatabase(
  run: (path: string, open: (provider?: EmbeddingProvider | null) => SQLiteStore) => Promise<void>
) {
  const dir = mkdtempSync(join(tmpdir(), "memobox-regression-"));
  const path = join(dir, "memory.db");
  const stores: SQLiteStore[] = [];
  try {
    await run(path, (provider = null) => {
      const store = new SQLiteStore(provider, path);
      stores.push(store);
      return store;
    });
  } finally {
    for (const store of stores) store.close();
    stores.length = 0;
    Bun.gc(true);
    // 仅允许清理由本测试创建的临时目录；Windows 句柄释放有短暂延迟。
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith("memobox-regression-")) {
      throw new Error("测试目录超出临时目录范围");
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
}

function provider(model = "model-a", flipped = false, space = "test-v1"): EmbeddingProvider {
  return {
    model,
    dimensions: 2,
    space,
    async embed(text) {
      const near = text === "query" || text === "alpha";
      return near !== flipped ? [1, 0] : [0, 1];
    },
  };
}

describe("共享记忆回归", () => {
  test("另一连接保存、更新、删除后，已预热的关键词和向量缓存同步", async () => {
    await withDatabase(async (_path, open) => {
      const a = open(provider());
      const b = open(provider());
      const seed = await b.save({ content: "alpha" });
      expect((await a.search("query"))[0].id).toBe(seed.id);
      const added = await b.save({ content: "zebra" });
      expect((await a.search("zebra")).map(m => m.id)).toContain(added.id);
      await b.update(seed.id, { content: "beta" });
      expect(await a.search("query")).toEqual([]);
      expect(await a.search("alpha")).toEqual([]);
      await b.forget(added.id);
      expect((await a.search("zebra")).map(m => m.id)).not.toContain(added.id);
      await a.save({ content: "walrus" });
      expect((await b.search("walrus")).map(m => m.content)).toContain("walrus");
    });
  });

  test("模型或处理版本变化后不使用旧向量，补算会重建向量", async () => {
    for (const replacement of [provider("model-b", true), provider("model-a", true, "test-v2")]) {
      await withDatabase(async (_path, open) => {
        const old = open(provider());
        await old.importMemories([
          { id: "alpha", content: "alpha", createdAt: 1 },
          { id: "beta", content: "beta", createdAt: 2 },
        ]);
        const current = open(replacement);
        expect(await current.search("query")).toEqual([]);
        expect((await current.backfillEmbeddings()).succeeded).toBe(2);
        expect((await current.search("query"))[0].id).toBe("alpha");
        expect((await current.backfillEmbeddings()).succeeded).toBe(0);
        // 老进程也必须发现新向量属于另一空间，不能错误比较。
        expect(await old.search("query")).toEqual([]);
      });
    }
  });

  test("外部写入后再本地写入，不会把旧缓存标记为最新", async () => {
    await withDatabase(async (_path, open) => {
      const a = open();
      const b = open();
      const seed = await a.save({ content: "obsolete" });
      await a.search("obsolete");
      await b.save({ content: "external" });
      await b.forget(seed.id);
      await a.save({ content: "local" });
      expect((await a.search("external"))[0].content).toBe("external");
      expect(await a.search("obsolete")).toEqual([]);
    });
  });

  test("查询等待嵌入期间的外部变动，在随后读取的快照中可见", async () => {
    await withDatabase(async (_path, open) => {
      let release!: () => void;
      const pause = new Promise<void>(resolve => { release = resolve; });
      let waiting = false;
      const embedder: EmbeddingProvider = {
        ...provider(), async embed(text) {
          if (waiting && text === "query") await pause;
          return [1, 0];
        },
      };
      const a = open(embedder);
      const b = open(embedder);
      const old = await b.save({ content: "alpha" });
      await a.search("query");
      waiting = true;
      const pending = a.search("query");
      await b.forget(old.id);
      const fresh = await b.save({ content: "replacement" });
      release();
      expect((await pending).map(m => m.id)).toEqual([fresh.id]);
    });
  });

  test("补算等待期间编辑内容，旧向量不会写回新内容", async () => {
    await withDatabase(async (_path, open) => {
      let release!: () => void;
      const pause = new Promise<void>(resolve => { release = resolve; });
      const b = open();
      const saved = await b.save({ content: "alpha" });
      const embedder: EmbeddingProvider = {
        ...provider(), async embed(text) { await pause; return text === "alpha" ? [1, 0] : [0, 1]; },
      };
      const a = open(embedder);
      const pending = a.backfillEmbeddings();
      await b.update(saved.id, { content: "beta" });
      release();
      expect((await pending).succeeded).toBe(0);
      expect((await a.backfillEmbeddings()).succeeded).toBe(1);
      expect((await a.search("synonym"))[0].content).toBe("beta");
    });
  });

  test("并发导入同一 id，只计一次导入且实体与实际记录一致", async () => {
    await withDatabase(async (_path, open) => {
      const a = open(provider());
      const b = open(provider());
      const results = await Promise.all([
        a.importMemories([{ id: "same", content: "alpha", entities: ["first"], createdAt: 1 }]),
        b.importMemories([{ id: "same", content: "beta", entities: ["second"], createdAt: 2 }]),
      ]);
      expect(results.reduce((sum, r) => sum + r.imported, 0)).toBe(1);
      expect(results.reduce((sum, r) => sum + r.skipped, 0)).toBe(1);
      const row = (await a.get("same"))!;
      expect(await a.topEntities()).toEqual([{ name: row.entities![0], memories: 1 }]);
    });
  });

  test("不同维度向量不截断比较，维度变化后补算", async () => {
    expect(() => cosineSim([1, 0, 100], [1, 0])).toThrow();
    await withDatabase(async (_path, open) => {
      await open(provider()).save({ content: "alpha" });
      const current = open({ model: "model-a", dimensions: 3, async embed() { return [1, 0, 0]; } });
      expect(await current.search("query")).toEqual([]);
      expect((await current.backfillEmbeddings()).succeeded).toBe(1);
      expect((await current.search("query"))[0].content).toBe("alpha");
    });
  });

  test("低相关、零向量和负相似度不召回，关键词仍可独立命中", async () => {
    await withDatabase(async (_path, open) => {
      const vectors: Record<string, number[]> = {
        query: [1, 0], near: [0.8, 0.6], weak: [0.1, 0.995],
        zero: [0, 0], negative: [-1, 0], keyword: [0, 1],
      };
      const store = open({ model: "relevance", dimensions: 2, async embed(text) { return vectors[text]; } });
      for (const content of ["near", "weak", "zero", "negative", "keyword"]) await store.save({ content });
      expect((await store.search("query")).map(m => m.content)).toEqual(["near"]);
      expect((await store.search("keyword")).map(m => m.content)).toContain("keyword");
    });
  });

  test("只修改 kind/entities 后向量保留，元数据与其他连接一致", async () => {
    await withDatabase(async (_path, open) => {
      const a = open(provider());
      const b = open(provider());
      const saved = await a.save({ content: "alpha" });
      await a.search("query");
      await b.search("query");
      await a.update(saved.id, { kind: "preference", entities: ["project"] });
      for (const store of [a, b]) {
        const hit = (await store.search("query"))[0];
        expect(hit.id).toBe(saved.id);
        expect(hit.kind).toBe("preference");
        expect(hit.entities).toEqual(["project"]);
        expect((await store.backfillEmbeddings()).succeeded).toBe(0);
      }
    });
  });

  test("实体关系写入失败时保存、更新、导入完整回滚，缓存不被污染", async () => {
    await withDatabase(async (path, open) => {
      const store = open(provider());
      const saved = await store.save({ content: "alpha", entities: ["original"] });
      await store.search("query");
      const fault = new Database(path);
      try {
        fault.exec(`CREATE TRIGGER reject_edge BEFORE INSERT ON memory_entity_edges
          BEGIN SELECT RAISE(ABORT, 'graph write failed'); END`);
        await expect(store.save({ content: "zebra", entities: ["broken"] })).rejects.toThrow("graph write failed");
        await expect(store.update(saved.id, { content: "beta", entities: ["broken"] })).rejects.toThrow("graph write failed");
        await expect(store.importMemories([{ id: "import-failed", content: "zebra", entities: ["broken"], createdAt: 1 }])).rejects.toThrow("graph write failed");
        expect((await store.stats()).total).toBe(1);
        expect(await store.search("zebra")).toEqual([]);
        expect((await store.search("query"))[0].content).toBe("alpha");
        expect(await store.topEntities()).toEqual([{ name: "original", memories: 1 }]);
      } finally { fault.close(); }
    });
  });

  test("旧库升级保留记忆，未知来源的向量只走关键词，补算后恢复语义", async () => {
    await withDatabase(async (path, open) => {
      const legacy = new Database(path);
      legacy.exec(`CREATE TABLE memories (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fact',
        source TEXT NOT NULL DEFAULT 'mcp', entities TEXT NOT NULL DEFAULT '[]',
        embedding TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`);
      legacy.query("INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("legacy", "alpha", "fact", "mcp", "[]", "[1,0]", 1, 1);
      legacy.close();
      const store = open(provider());
      expect((await store.search("alpha"))[0].id).toBe("legacy");
      expect(await store.search("query")).toEqual([]);
      expect((await store.backfillEmbeddings()).succeeded).toBe(1);
      expect((await store.search("query"))[0].id).toBe("legacy");
    });
  });
});
