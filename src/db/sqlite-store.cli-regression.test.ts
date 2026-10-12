import { expect, test } from "bun:test";
import { SQLiteStore } from "./sqlite-store";

test("保存/编辑/导入统一拒绝空白内容和无效类型，批量验证不留部分数据", async () => {
  const store = new SQLiteStore(null, ":memory:");
  try {
    for (const input of [{ content: " \n\t" }, { content: "正常内容", kind: "无效类型" }]) {
      await expect(store.save(input)).rejects.toThrow();
    }
    expect((await store.stats()).total).toBe(0);
    const saved = await store.save({ content: "原始内容", kind: "fact" });
    await expect(store.update(saved.id, { content: " " })).rejects.toThrow();
    await expect(store.update(saved.id, { kind: "乱填" })).rejects.toThrow();
    expect((await store.get(saved.id))?.content).toBe("原始内容");
    await expect(store.importMemories([
      { id: "valid", content: "有效记忆", createdAt: 1 },
      { id: "invalid", content: " ", createdAt: 2 },
    ])).rejects.toThrow();
    expect(await store.get("valid")).toBeNull();
  } finally { store.close(); }
});

test("结构化过滤覆盖全库旧记忆，中文实体和字面量百分号正确，分页稳定", async () => {
  const store = new SQLiteStore(null, ":memory:");
  try {
    await store.importMemories([
      { id: "old", content: "最早的记忆含 100%_完成", kind: "decision", entities: ["项目甲", "ÜBER"], source: "中文终端", createdAt: 1 },
      ...Array.from({ length: 2001 }, (_, i) => ({ id: `row-${String(i).padStart(4, "0")}`, content: `填充 ${i}`, createdAt: 2 })),
    ]);
    const query = { text: "100%_完成", kind: "decision", entity: "über", source: "中文终端", since: 0, limit: 20 };
    expect((await store.query(query)).map(m => m.id)).toEqual(["old"]);
    const first = await store.query({ limit: 2 });
    const next = await store.query({ limit: 2, offset: 2 });
    expect(first).toHaveLength(2);
    expect(next).toHaveLength(2);
    expect(new Set([...first, ...next].map(m => m.id)).size).toBe(4);
  } finally { store.close(); }
}, 10000);

test("补算失败报告已处理和失败条数，可重试；已匹配的向量计为跳过", async () => {
  let broken = true;
  const store = new SQLiteStore({ model: "failure-test", dimensions: 2, async embed() {
    if (broken) throw Error("模拟端点故障");
    return [1, 0];
  } }, ":memory:");
  try {
    await store.save({ content: "补算回归" });
    const progress: [number, number][] = [];
    expect(await store.backfillEmbeddings((done, total) => progress.push([done, total]))).toMatchObject({
      inspected: 1, needed: 1, processed: 1, succeeded: 0, skipped: 0, failed: 1,
    });
    expect(progress).toEqual([[1, 1]]);
    broken = false;
    expect(await store.backfillEmbeddings()).toMatchObject({ succeeded: 1, failed: 0 });
    expect(await store.backfillEmbeddings()).toMatchObject({ inspected: 1, needed: 0, skipped: 1, failed: 0 });
  } finally { store.close(); }
});
