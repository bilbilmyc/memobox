import { test, expect } from "bun:test";
import { SQLiteStore } from "./db/sqlite-store";
import { runCli } from "./cli";
import { handleRpcBody } from "./lib/mcp";

test("解释区分关键词命中与实体扩展，保留原检索顺序且只记一次日志", async () => {
  const store = new SQLiteStore(null, ":memory:");
  try {
    await store.importMemories([
      { id: "direct", content: "部署 needle", entities: ["项目甲"], createdAt: 1 },
      { id: "linked", content: "使用 SQLite", entities: ["项目甲"], createdAt: 2 },
      { id: "outside", content: "needle", entities: ["项目乙"], createdAt: 3 },
    ]);
    const report = await store.searchDetailed("needle", 5, { entity: "项目甲" });
    expect(report.memories.map(m => m.id)).toEqual(["direct", "linked"]);
    expect(report.explanation.mode).toBe("keyword");
    expect(report.explanation.semantic.status).toBe("disabled");
    expect(report.explanation.hits[0].keyword?.rank).toBe(1);
    expect(report.explanation.hits[0].keyword!.score).toBeGreaterThan(0);
    expect(report.explanation.hits[0].graph).toBeUndefined();
    expect(report.explanation.hits[1].keyword).toBeUndefined();
    expect(report.explanation.hits[1].graph?.entities).toEqual(["项目甲"]);
    expect((await store.stats()).searches).toBe(1);
    expect(await store.search("needle", 5, { entity: "项目甲" })).toEqual(report.memories);
    expect((await store.stats()).searches).toBe(2);
  } finally { store.close(); }
});

test("混合解释报告实际余弦与融合贡献，模型异常、零向量及空间漂移都有安全原因", async () => {
  let queryVector = [1, 0], fail = false;
  const provider = { model: "explain-fixture", dimensions: 2, async embed(text: string) {
    if (fail) throw Error("https://user:private-secret@example.test/?key=hidden");
    if (text === "related") return [0.8, 0.6];
    return queryVector;
  } };
  const store = new SQLiteStore(provider, ":memory:");
  try {
    await store.importMemories([
      { id: "direct", content: "needle", createdAt: 1 },
      { id: "related", content: "related", createdAt: 2 },
    ]);
    const report = await store.searchDetailed("needle", 5);
    expect(report.memories.map(m => m.id)).toEqual(["direct", "related"]);
    expect(report.explanation.mode).toBe("hybrid");
    expect(report.explanation.hits[0]).toMatchObject({ keyword: { rank: 1 }, semantic: { rank: 1, score: 1 } });
    expect(report.explanation.hits[0].rrfScore).toBeCloseTo(0.03278688524590164, 12);
    expect(report.explanation.hits[1].semantic?.score).toBeCloseTo(0.8, 6);
    expect(report.explanation.hits[1].keyword).toBeUndefined();
    fail = true;
    const fallback = await store.searchDetailed("needle");
    expect(fallback.memories.map(m => m.id)).toEqual(["direct"]);
    expect(fallback.explanation.semantic).toEqual({ status: "unavailable", reason: "embedding_failed" });
    expect(JSON.stringify(fallback)).not.toContain("private-secret");
    fail = false; queryVector = [0, 0];
    expect((await store.searchDetailed("needle")).explanation.semantic).toEqual({ status: "unavailable", reason: "zero_vector" });
    queryVector = [-1, 0];
    expect((await store.searchDetailed("needle")).explanation.semantic).toEqual({ status: "no_matches", reason: "below_threshold" });
    queryVector = [1, 0]; provider.model = "changed-model";
    expect((await store.searchDetailed("needle")).explanation.semantic).toEqual({ status: "no_matches", reason: "no_compatible_vectors" });
    expect((await store.stats()).searches).toBe(5);
  } finally { store.close(); }
});

test("CLI 和 MCP 可显式解释中文检索，默认 JSON 数组仍兼容", async () => {
  const store = new SQLiteStore(null, ":memory:"), out: string[] = [];
  const io = { out: (s: string) => out.push(s), err: () => {} };
  try {
    await store.save({ content: "开发端口 3100", entities: ["项目甲"] });
    expect(await runCli(["search", "端口", "--entity", "项目甲", "--explain", "--json"], io, () => store)).toBe(0);
    const report = JSON.parse(out.pop()!);
    expect(report.explanation.hits[0].keyword.rank).toBe(1);
    expect(report.memories[0].content).toBe("开发端口 3100");
    expect(await runCli(["search", "端口", "--explain"], io, () => store)).toBe(0);
    expect(out.join("\n")).toContain("关键词");
    out.length = 0;
    expect(await runCli(["search", "端口", "--json"], io, () => store)).toBe(0);
    expect(Array.isArray(JSON.parse(out[0]))).toBe(true);
    const response = await handleRpcBody(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_search", arguments: { query: "端口", explain: true } } }), store);
    const result = (response.body as { result: { structuredContent: typeof report; content: { text: string }[] } }).result;
    expect(result.structuredContent.explanation.hits[0].keyword.rank).toBe(1);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect((await store.stats()).searches).toBe(4);
  } finally { store.close(); }
});
