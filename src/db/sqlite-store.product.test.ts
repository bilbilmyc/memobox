import { test, expect } from "bun:test";
import { SQLiteStore } from "./sqlite-store";

for (const semantic of [false, true]) test(`检索范围在${semantic ? "混合" : "关键词"}排名截断和实体扩展前生效`, async () => {
  const provider = { model: "scope-fixture", dimensions: 2, async embed() { return [1, 0]; } };
  const store = new SQLiteStore(semantic ? provider : null, ":memory:");
  try {
    await store.importMemories([
      ...Array.from({ length: 30 }, (_, i) => ({ id: "outside-" + i, content: "needle", entities: ["共同标签", "项目乙"], source: "other", kind: "fact", createdAt: 100 + i })),
      { id: "inside", content: "needle 范围内的中文记忆", entities: ["共同标签", "项目甲"], source: "owner", kind: "decision", createdAt: 10 },
      { id: "linked", content: "关联说明", entities: ["共同标签", "项目甲"], source: "owner", kind: "decision", createdAt: 11 },
      { id: "wrong-kind", content: "needle", entities: ["项目甲"], source: "owner", kind: "fact", createdAt: 12 },
      { id: "too-old", content: "needle", entities: ["项目甲"], source: "owner", kind: "decision", createdAt: 1 },
    ]);
    // 先预热全库，不能留下跨范围候选；范围内记忆在全库前 20 名以外。
    await store.search("needle", 1);
    const scope = { source: "owner", entity: "项目甲", kind: "decision", since: 10 };
    const hits = await store.search("needle", 5, scope);
    expect(hits.map(m => m.id).sort()).toEqual(["inside", "linked"]);
    expect((await store.search("needle", 1, scope))[0]?.id).toBe("inside");
    expect(await store.search("needle", 5, { source: "nobody" })).toEqual([]);
    await store.update("inside", { source: "other" });
    expect((await store.search("needle", 5, scope)).map(m => m.id)).not.toContain("inside");
  } finally { store.close(); }
});

test("同分关键词结果保留原顺序，不随查询词顺序或倒排候选顺序变化", async () => {
  const store = new SQLiteStore(null, ":memory:");
  try {
    await store.importMemories([
      { id: "first", content: "beta", createdAt: 1 },
      { id: "second", content: "alpha", createdAt: 1 },
      { id: "filler-1", content: "other", createdAt: 1 },
      { id: "filler-2", content: "unrelated", createdAt: 1 },
      { id: "filler-3", content: "elsewhere", createdAt: 1 },
      { id: "filler-4", content: "unconnected", createdAt: 1 },
    ]);
    for (const query of ["alpha beta", "beta alpha", "alpha beta"]) {
      expect((await store.search(query)).map(m => m.id)).toEqual(["first", "second"]);
    }
  } finally { store.close(); }
});

test("没有可分词字母的 emoji 和符号仍可按原文检索", async () => {
  const store = new SQLiteStore(null, ":memory:");
  try {
    const saved = await store.save({ content: "发布检查 ✅ 完成，心情 🙂" });
    for (const query of ["✅", "🙂"]) expect((await store.search(query)).map(m => m.id)).toEqual([saved.id]);
  } finally { store.close(); }
});

test("预热后的图谱检索随实体修订及删除立即变化，不遗留候选", async () => {
  const store = new SQLiteStore(null, ":memory:");
  try {
    await store.importMemories([
      { id: "seed", content: "入口 seed", entities: ["共享标签"], createdAt: 1 },
      { id: "linked", content: "关联结论", entities: ["共享标签"], createdAt: 2 },
      { id: "other", content: "另一个领域", entities: ["其他标签"], createdAt: 3 },
    ]);
    expect((await store.search("seed")).map(m => m.id)).toEqual(["seed", "linked"]);
    await store.update("linked", { entities: ["其他标签"] });
    expect((await store.search("seed")).map(m => m.id)).toEqual(["seed"]);
    await store.update("other", { entities: ["共享标签"] });
    expect((await store.search("seed")).map(m => m.id)).toEqual(["seed", "other"]);
    await store.forget("other");
    expect((await store.search("seed")).map(m => m.id)).toEqual(["seed"]);
  } finally { store.close(); }
});
