import { describe, expect, test } from "bun:test";
import { handleLine, postRpc } from "./stdio-bridge";

/**
 * stdio 桥纯逻辑单测：不碰真网络，用假 fetch 模拟 /mcp 的三种回复
 * （JSON 响应 / 202 通知吞掉 / 连接失败）。
 */

/** 造一个记录调用参数、返回固定响应的假 fetch */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 202 ? null : JSON.stringify(body), {
      status,
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** 永远连不上的假 fetch（网络层失败） */
const deadFetch = (async () => {
  throw new Error("connection refused");
}) as unknown as typeof fetch;

describe("postRpc", () => {
  test("forwards the line as JSON and parses the response", async () => {
    const { fn, calls } = fakeFetch(200, { jsonrpc: "2.0", id: 1, result: {} });
    const r = await postRpc("http://x/mcp", '{"jsonrpc":"2.0","id":1}', fn);
    expect(r.skip).toBe(false);
    expect(r.body).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    // 请求头声明纯 JSON 模式
    expect(calls[0].init?.headers).toMatchObject({
      "content-type": "application/json",
      accept: "application/json",
    });
  });

  test("202 (notification) → skip", async () => {
    const { fn } = fakeFetch(202, null);
    const r = await postRpc("http://x/mcp", '{"jsonrpc":"2.0","method":"x"}', fn);
    expect(r.skip).toBe(true);
  });

  test("network failure → -32603 with the request id preserved", async () => {
    const r = await postRpc("http://x/mcp", '{"jsonrpc":"2.0","id":42}', deadFetch);
    expect(r.skip).toBe(false);
    const body = r.body as { id: unknown; error: { code: number; message: string } };
    expect(body.id).toBe(42);
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toContain("cannot reach");
  });

  test("non-JSON response (e.g. plain-text 401) → synthetic error, no crash", async () => {
    // 服务端开了 MCP_TOKEN 而桥没配令牌时会拿到 401 纯文本
    const fn = (async () =>
      new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const r = await postRpc("http://x/mcp", '{"jsonrpc":"2.0","id":7}', fn);
    expect(r.skip).toBe(false);
    const body = r.body as { id: unknown; error: { code: number; message: string } };
    expect(body.id).toBe(7);
    expect(body.error.message).toContain("HTTP 401");
  });
});

describe("handleLine", () => {
  test("empty line → silence", async () => {
    expect(await handleLine("http://x/mcp", "   ")).toBeNull();
  });

  test("invalid JSON → -32700", async () => {
    const out = await handleLine("http://x/mcp", "{not json", deadFetch);
    const body = JSON.parse(out!) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  test("batch is split, forwarded, and reassembled", async () => {
    // 按报文有无 id 区分响应：请求 → 200 JSON，通知 → 202（服务端真实行为）
    const fn = (async (_url: string, init?: RequestInit) => {
      const hasId = JSON.parse(String(init?.body)).id != null;
      return hasId
        ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 })
        : new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const out = await handleLine(
      "http://x/mcp",
      '[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"n"}]',
      fn
    );
    const arr = JSON.parse(out!) as unknown[];
    expect(arr.length).toBe(1); // 通知无响应，数组只剩请求的响应
    expect(arr[0]).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  test("batch of pure notifications → silence", async () => {
    // 两次 202：通知被吞，批量无响应内容
    const fn = (async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
    const out = await handleLine(
      "http://x/mcp",
      '[{"jsonrpc":"2.0","method":"a"},{"jsonrpc":"2.0","method":"b"}]',
      fn
    );
    expect(out).toBeNull();
  });
});
