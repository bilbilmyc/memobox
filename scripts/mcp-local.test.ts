import { describe, expect, test } from "bun:test";
import { handleLocal } from "./mcp-local";
import { StubStore } from "../src/lib/memory-store";
import type { MemoryStore } from "../src/lib/memory-store";

/** handleLocal 是纯函数（store 注入），直接用 StubStore 测协议行为 */
function store(): MemoryStore {
  return new StubStore();
}

const rpc = (id: unknown, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("mcp-local handleLine", () => {
  test("initialize 返回 serverInfo", async () => {
    const out = await handleLocal(
      store(),
      rpc(1, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      })
    );
    const parsed = out && JSON.parse(out);
    expect(parsed.result.serverInfo.name).toBe("memobox");
  });

  test("空行与通知保持沉默", async () => {
    const s = store();
    expect(await handleLocal(s, "   ")).toBeNull();
    expect(
      await handleLocal(s, '{"jsonrpc":"2.0","method":"notifications/initialized"}')
    ).toBeNull();
  });

  test("非法 JSON → -32700", async () => {
    const out = await handleLocal(store(), "{oops");
    const parsed = out && JSON.parse(out);
    expect(parsed.error.code).toBe(-32700);
  });

  test("save → search 闭环", async () => {
    const s = store();
    await handleLocal(
      s,
      rpc(1, "tools/call", {
        name: "memory_save",
        arguments: { content: "cli roundtrip probe", entities: ["cli"] },
      })
    );
    const out = await handleLocal(
      s,
      rpc(2, "tools/call", {
        name: "memory_search",
        arguments: { query: "roundtrip" },
      })
    );
    const parsed = out && JSON.parse(out);
    expect(parsed.result.content[0].text).toContain("cli roundtrip probe");
  });

  test("批量报文拆开重组，全通知则沉默", async () => {
    const s = store();
    const batch = await handleLocal(
      s,
      JSON.stringify([
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 7, method: "tools/list" },
      ])
    );
    const parsed = batch && JSON.parse(batch);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(7);

    const silent = await handleLocal(
      s,
      JSON.stringify([{ jsonrpc: "2.0", method: "notifications/initialized" }])
    );
    expect(silent).toBeNull();
  });

  test("未知方法 → JSON-RPC 错误", async () => {
    const out = await handleLocal(store(), rpc(5, "no/such/method"));
    const parsed = out && JSON.parse(out);
    expect(parsed.id).toBe(5);
    expect(parsed.error).toBeDefined();
  });
});
