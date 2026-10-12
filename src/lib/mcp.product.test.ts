import { test, expect } from "bun:test";
import { SQLiteStore } from "../db/sqlite-store";
import { handleRpcBody } from "./mcp";

test("MCP 范围搜索不越过项目和来源，非法范围不启动检索", async () => {
  const store = new SQLiteStore(null, ":memory:");
  const call = async (args: unknown) => {
    const response = await handleRpcBody(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_search", arguments: args } }), store);
    return (response.body as { result: { isError?: boolean; structuredContent?: { memories: { id: string }[] } } }).result;
  };
  try {
    const row = await store.save({ content: "中文端口偏好", kind: "decision", entities: ["项目甲"], source: "owner" });
    await store.save({ content: "中文端口偏好", entities: ["项目乙"], source: "other" });
    const result = await call({ query: "端口", entity: "项目甲", source: "owner", kind: "decision", since: row.createdAt });
    expect(result.structuredContent?.memories.map(m => m.id)).toEqual([row.id]);
    expect((await call({ query: "端口", source: "owner", typo: true })).isError).toBe(true);
    expect((await call({ query: "端口", entity: " " })).isError).toBe(true);
    expect((await store.stats()).searches).toBe(1);
  } finally { store.close(); }
});

test("MCP 可查看、修订、过滤和遗忘同一条记忆，非法补丁不写入", async () => {
  const store = new SQLiteStore(null, ":memory:");
  const call = async (name: string, args: unknown) => {
    const reply = await handleRpcBody(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), store);
    return (reply.body as { result: { isError?: boolean; structuredContent: { memory?: { id: string; content: string }; memories?: { id: string }[]; deleted?: boolean } } }).result;
  };
  try {
    const row = await store.save({ content: "旧内容" });
    expect((await call("memory_get", { id: row.id })).structuredContent?.memory?.content).toBe("旧内容");
    expect((await call("memory_update", { id: row.id, content: "新的中文决策", kind: "decision", entities: ["中文项目"], source: "agent" })).isError).not.toBe(true);
    expect((await call("memory_update", { id: row.id, typo: "不应更新" })).isError).toBe(true);
    expect((await call("memory_update", { id: row.id })).isError).toBe(true);
    const query = await call("memory_query", { kind: "decision", entity: "中文项目", source: "agent", limit: 1 });
    expect(query.structuredContent.memories?.map(m => m.id)).toEqual([row.id]);
    expect((await store.get(row.id))?.content).toBe("新的中文决策");
    expect((await call("memory_forget", { id: row.id })).structuredContent.deleted).toBe(true);
    expect(await store.get(row.id)).toBeNull();
    expect((await call("memory_get", { id: row.id })).isError).toBe(true);
  } finally { store.close(); }
});
