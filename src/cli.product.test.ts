import { test, expect } from "bun:test";
import { runCli } from "./cli";
import { SQLiteStore } from "./db/sqlite-store";

test("CLI 范围搜索支持中文类型、完整实体和来源，JSON 可解析，非法日期先拒绝", async () => {
  const store = new SQLiteStore(null, ":memory:");
  const out: string[] = [], io = { out: (s: string) => out.push(s), err: () => {} };
  try {
    const inside = await store.save({ content: "端口 3100", kind: "decision", entities: ["项目甲"], source: "owner" });
    await store.save({ content: "端口 3100", kind: "fact", entities: ["项目乙"], source: "other" });
    expect(await runCli(["search", "端口", "--kind", "决策", "--entity", "项目甲", "--source", "owner", "--since", "1d", "--json"], io, () => store)).toBe(0);
    expect(JSON.parse(out[0]).map((m: { id: string }) => m.id)).toEqual([inside.id]);
    expect(await runCli(["search", "端口", "--since", "错误日期"], io, () => { throw Error("参数错误前不应建库"); })).toBe(2);
  } finally { store.close(); }
});

test("CLI 编辑保留编号和创建时间，中文元数据更新与实体清除可查询", async () => {
  const store = new SQLiteStore(null, ":memory:");
  const out: string[] = [], err: string[] = [];
  const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  try {
    const original = await store.save({ content: "旧端口 3000", entities: ["旧项目"], source: "old" });
    expect(await runCli(["update", original.id, "新端口 3100", "--kind", "决策", "--entities", "新项目", "--source", "人工修订", "--json"], io, () => store)).toBe(0);
    expect(JSON.parse(out[0])).toEqual({ ...original, content: "新端口 3100", kind: "decision", entities: ["新项目"], source: "人工修订" });
    expect(await store.search("旧端口 3000")).not.toContainEqual(original);
    expect(await runCli(["update", original.id, "--clear-entities"], io, () => store)).toBe(0);
    expect((await store.get(original.id))?.entities).toEqual([]);
    expect(await runCli(["update", original.id], io, () => store)).toBe(2);
    expect(await runCli(["update", original.id, "不应保存", "--dry-run"], io, () => store)).toBe(2);
    expect((await store.get(original.id))?.content).toBe("新端口 3100");
  } finally { store.close(); }
});
