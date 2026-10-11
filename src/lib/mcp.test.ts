import { describe, expect, test } from "bun:test";
import { handleRpcBody } from "./mcp";
import type { Memory, MemoryStore } from "./memory-store";

/** Minimal in-memory fake for protocol-level tests. */
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
    async list(limit: number) {
      return [...rows.values()].slice(0, limit);
    },
    async recentQueries() {
      return [];
    },
    async stats() {
      return { total: rows.size, searches: 0 };
    },
  };
}

const rpc = (id: unknown, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("handleRpcBody", () => {
  test("initialize echoes client protocolVersion", async () => {
    const res = await handleRpcBody(
      rpc(1, "initialize", { protocolVersion: "2025-03-26" }),
      fakeStore()
    );
    const body = res.body as { result: { protocolVersion: string } };
    expect(res.status).toBe(200);
    expect(body.result.protocolVersion).toBe("2025-03-26");
  });

  test("tools/list exposes both tools", async () => {
    const res = await handleRpcBody(rpc(2, "tools/list"), fakeStore());
    const body = res.body as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual([
      "memory_save",
      "memory_search",
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
});
