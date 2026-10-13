import { test, expect } from "bun:test";
import { SQLiteStore } from "./db/sqlite-store";
import { StubStore } from "./lib/memory-store";
import { runCli } from "./cli";
import { handleRpcBody } from "./lib/mcp";

for (const backend of ["sqlite", "stub"]) test(`${backend} 检索反馈保留当时顺序、补标漏召回，改标和撤销只影响标注`, async () => {
  const store = backend === "sqlite" ? new SQLiteStore(null, ":memory:") : new StubStore();
  try {
    await store.importMemories([{ id: "hit", content: "needle hit", createdAt: 1 }, { id: "miss", content: "another relevant fact", createdAt: 2 }]);
    const report = await store.searchDetailed("needle", 5);
    expect(report.queryId).toBeString();
    const id = report.queryId!;
    expect((await store.getQuery(id))?.recalledIds).toEqual(["hit"]);
    await store.label(id, "hit", true);
    await store.label(id, "miss", true);
    expect(await store.benchmark()).toEqual({ labeledQueries: 1, recall: .5, precision: 1 });
    await store.label(id, "hit", false);
    expect(await store.benchmark()).toEqual({ labeledQueries: 1, recall: 0, precision: 0 });
    await expect(store.label(id, "miss", false)).rejects.toThrow("not recalled");
    await expect(store.label("missing-query", "hit", true)).rejects.toThrow("Query not found");
    await expect(store.label(id, "missing-memory", true)).rejects.toThrow("Memory not found");
    expect((await store.getQuery(id))?.labels).toHaveLength(2);
    await store.unlabel(id, "hit"); await store.unlabel(id, "hit"); await store.unlabel(id, "miss");
    expect(await store.benchmark()).toEqual({ labeledQueries: 0, recall: null, precision: null });
    expect((await store.unlabeledQueries()).map(row => row.id)).toContain(id);
    await store.label(id, "hit", true);
    await store.forget("hit");
    const review = await store.getQuery(id);
    expect(review?.recalledIds).toEqual(["hit"]);
    expect(review?.recalled).toEqual([]);
    expect(review?.labels).toEqual([]);
    expect((await store.stats()).searches).toBe(1);
  } finally { if (store instanceof SQLiteStore) store.close(); }
});

test("零命中可以补标相关记忆，CLI/MCP 跨入口共享同一日志和报告", async () => {
  const store = new SQLiteStore(null, ":memory:");
  const cli = async (args: string[]) => { const out: string[] = [], err: string[] = []; const code = await runCli(args, { out: s => out.push(s), err: s => err.push(s) }, () => store); return { code, out: out.join("\n"), err: err.join("\n") }; };
  const tool = async (name: string, args: unknown) => (await handleRpcBody(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), store)).body as any;
  try {
    const memory = await store.save({ content: "something relevant" });
    const search = await tool("memory_search", { query: "no_match_marker", explain: true });
    const queryId = search.result.structuredContent.queryId;
    expect(queryId).toBeString();
    for (const args of [{ queryId: " ", memoryId: memory.id, relevant: true }, { queryId, memoryId: memory.id },
      { queryId, memoryId: memory.id, relevant: "true" }, { queryId, memoryId: memory.id, relevant: true, unexpected: 1 }]) {
      expect((await tool("memory_feedback", args)).result.isError).toBe(true);
    }
    expect((await store.getQuery(queryId))?.labels).toEqual([]);
    expect((await cli(["eval", "label", queryId, memory.id, "相关", "--json"])).code).toBe(0);
    const report = JSON.parse((await cli(["eval", "report", "--json"])).out);
    expect(report.benchmark).toEqual({ labeledQueries: 1, recall: 0, precision: null });
    expect(report.stats.zeroRecall).toBe(1);
    const recent = JSON.parse((await cli(["eval", "recent", "--json"])).out);
    expect(recent[0].id).toBe(queryId);
    expect(JSON.parse((await cli(["eval", "show", queryId, "--json"])).out).labels).toHaveLength(1);
    expect((await tool("memory_feedback", { queryId, memoryId: memory.id, relevant: false })).result.isError).toBe(true);
    expect((await tool("memory_feedback", { queryId, memoryId: memory.id, relevant: null })).result.structuredContent.relevant).toBeNull();
    expect(JSON.parse((await cli(["eval", "report", "--json"])).out).benchmark.labeledQueries).toBe(0);
    expect((await cli(["eval", "report"])).out).toContain("未标注");
    expect((await cli(["eval", "show", queryId])).out).toContain("当时无召回");
    expect((await cli(["eval", "show", "missing"])).err).toContain("未找到检索记录");
    expect((await store.stats()).searches).toBe(1);
  } finally { store.close(); }
});

for (const backend of ["sqlite", "stub"]) test(`${backend} 未标注队列先过滤再限制，改写记忆后历史详情明确显示当前内容`, async () => {
  const store = backend === "sqlite" ? new SQLiteStore(null, ":memory:") : new StubStore();
  try {
    const memory = await store.save({ content: "needle original" });
    const first = await store.searchDetailed("needle"), second = await store.searchDetailed("needle");
    const recent = await store.recentQueries(2);
    expect(recent).toHaveLength(2);
    await store.label(recent[0].id, memory.id, true);
    expect((await store.unlabeledQueries(1)).map(row => row.id)).toEqual([recent[1].id]);
    await store.update(memory.id, { content: "edited now" });
    expect((await store.getQuery(first.queryId!))?.recalled[0].content).toBe("edited now");
    expect((await store.getQuery(second.queryId!))?.recalledIds).toEqual([memory.id]);
    expect((await store.recentQueries(1))[0].relevantIds).toEqual([memory.id]);
    await expect(store.unlabel("missing-query", memory.id)).rejects.toThrow("Query not found");
  } finally { if (store instanceof SQLiteStore) store.close(); }
});

test("反馈非法参数和帮助先处理，不打开数据库", async () => {
  let opened = 0; const makeStore = () => { opened++; return new StubStore(); };
  for (const args of [["eval", "label", "q", "m", "maybe"], ["eval", "show", " "], ["eval", "unlabel", "q"], ["eval", "recent", "--limit", "0"], ["eval", "report", "--unlabeled"], ["eval", "unknown"]]) {
    expect(await runCli(args, { out() {}, err() {} }, makeStore)).toBe(2);
  }
  for (const args of [["eval", "--help"], ["eval", "label", "--help"], ["help", "eval", "report"]]) {
    expect(await runCli(args, { out() {}, err() {} }, makeStore)).toBe(0);
  }
  expect(opened).toBe(0);
});
