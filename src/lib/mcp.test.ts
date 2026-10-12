import { describe, expect, test } from "bun:test";
import { handleRpcBody } from "./mcp";
import type { Memory, MemoryStore } from "./memory-store";

/** 协议层测试用的最小内存 fake store */
function fakeStore(): MemoryStore {
  const rows = new Map<string, Memory>();
  return {
    backend: "fake",
    retrieval: "keyword" as const,
    async save(input) {
      const row: Memory = { id: `t${rows.size + 1}`, createdAt: 1, ...input };
      rows.set(row.id, row);
      return row;
    },
    async search(query: string, limit = 5) {
      return [...rows.values()]
        .filter((r) => r.content.includes(query))
        .slice(0, limit);
    },
    async searchDetailed(query: string, limit = 5) {
      const memories = await this.search(query, limit);
      return { memories, explanation: { mode: "keyword", semantic: { status: "disabled" }, hits: memories.map(m => ({ id: m.id })) } };
    },
    async query() { return []; },
    async list(limit: number) {
      return [...rows.values()].slice(0, limit);
    },
    async get(id: string) {
      return rows.get(id) ?? null;
    },
    async update(
      id: string,
      patch: { content?: string; kind?: string; entities?: string[] }
    ) {
      const row = rows.get(id);
      if (!row) return null;
      const next = { ...row, ...patch };
      rows.set(id, next);
      return next;
    },
    async forget(id: string) {
      return rows.delete(id);
    },
    async topEntities(limit = 20) {
      const counts = new Map<string, number>();
      for (const r of rows.values()) {
        for (const e of r.entities ?? []) {
          counts.set(e, (counts.get(e) ?? 0) + 1);
        }
      }
      return [...counts.entries()]
        .map(([name, memories]) => ({ name, memories }))
        .sort((a, b) => b.memories - a.memories)
        .slice(0, limit);
    },
    async evalStats() {
      return { totalQueries: 0, zeroRecall: 0, p50LatencyMs: 0, p95LatencyMs: 0 };
    },
    async label() {},
    async unlabel() {},
    async getQuery() {
      return null;
    },
    async unlabeledQueries() {
      return [];
    },
    async benchmark() {
      return { labeledQueries: 0, recall: null, precision: null };
    },
    async recentQueries() {
      return [];
    },
    async stats() {
      return { total: rows.size, searches: 0 };
    },
    async exportAll() {
      return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    async importMemories(items: Memory[]) {
      let imported = 0;
      for (const item of items) {
        if (!rows.has(item.id)) {
          rows.set(item.id, item);
          imported++;
        }
      }
      return { imported, skipped: items.length - imported };
    },
    async backfillEmbeddings() {
      return { inspected: 0, needed: 0, processed: 0, succeeded: 0, skipped: 0, failed: 0 };
    },
  };
}

const rpc = (id: unknown, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("handleRpcBody", () => {
  test("blank content and unknown kinds fail before persistence", async () => {
    const store = fakeStore();
    for (const args of [{ content: " \n\t" }, { content: "valid", kind: "unknown" }]) {
      const res = await handleRpcBody(rpc(9, "tools/call", { name: "memory_save", arguments: args }), store);
      expect((res.body as { result: { isError: boolean } }).result.isError).toBe(true);
    }
    expect((await store.stats()).total).toBe(0);
  });
  test("initialize echoes client protocolVersion", async () => {
    const res = await handleRpcBody(
      rpc(1, "initialize", { protocolVersion: "2025-03-26" }),
      fakeStore()
    );
    const body = res.body as { result: { protocolVersion: string } };
    expect(res.status).toBe(200);
    expect(body.result.protocolVersion).toBe("2025-03-26");
  });

  test("tools/list exposes memory creation, recall and maintenance tools", async () => {
    const res = await handleRpcBody(rpc(2, "tools/list"), fakeStore());
    const body = res.body as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual([
      "memory_save",
      "memory_search",
      "memory_entities",
      "memory_get", "memory_update", "memory_forget", "memory_query",
    ]);
  });

  test("save then search roundtrips", async () => {
    const store = fakeStore();
    await handleRpcBody(
      rpc(3, "tools/call", {
        name: "memory_save",
        arguments: { content: "memobox uses bun and next", entities: ["memobox"] },
      }),
      store
    );
    const res = await handleRpcBody(
      rpc(4, "tools/call", {
        name: "memory_search",
        arguments: { query: "bun and next" },
      }),
      store
    );
    const body = res.body as { result: { content: { text: string }[] } };
    expect(body.result.content[0].text).toContain("memobox uses bun and next");
  });

  test("invalid tool args return isError, not RPC error", async () => {
    const res = await handleRpcBody(
      rpc(5, "tools/call", { name: "memory_save", arguments: { content: "" } }),
      fakeStore()
    );
    const body = res.body as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
  });

  test("storage failures surface as tool errors", async () => {
    const broken: MemoryStore = {
      ...fakeStore(),
      async save() {
        throw new Error("connection refused");
      },
    };
    const res = await handleRpcBody(
      rpc(6, "tools/call", {
        name: "memory_save",
        arguments: { content: "x" },
      }),
      broken
    );
    const body = res.body as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("connection refused");
  });

  test("unknown method returns -32601", async () => {
    const res = await handleRpcBody(rpc(7, "nope"), fakeStore());
    const body = res.body as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  test("parse error returns -32700", async () => {
    const res = await handleRpcBody("{not json", fakeStore());
    const body = res.body as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  test("notifications get 202 with no body", async () => {
    const res = await handleRpcBody(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      fakeStore()
    );
    expect(res.status).toBe(202);
    expect(res.body).toBeUndefined();
  });

  test("memory_entities lists entity counts", async () => {
    // 先种两条带实体的记忆，再查实体榜
    const store = fakeStore();
    await store.save({ content: "a", entities: ["memobox", "postgres"] });
    await store.save({ content: "b", entities: ["memobox"] });
    const res = await handleRpcBody(
      rpc(9, "tools/call", { name: "memory_entities", arguments: {} }),
      store
    );
    const body = res.body as { result: { content: { text: string }[] } };
    const text = body.result.content[0].text;
    expect(text).toContain("memobox (2)");
    expect(text).toContain("postgres (1)");
  });

  test("search output includes entity tags", async () => {
    const store = fakeStore();
    const saved = await store.save({
      content: "hello entity tags",
      entities: ["memobox"],
    });
    const res = await handleRpcBody(
      rpc(10, "tools/call", {
        name: "memory_search",
        arguments: { query: saved.content },
      }),
      store
    );
    const body = res.body as { result: { content: { text: string }[] } };
    expect(body.result.content[0].text).toContain("(entities: memobox)");
  });
});
