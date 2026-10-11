import { describe, expect, test } from "bun:test";
import { formatPullStatus, ollamaModels, ollamaUp, pullOllamaModel } from "./ollama";

describe("ollama 探测（注入假 fetch，不碰真网络）", () => {
  test("ollamaUp：2xx = 在跑；请求异常 = 没跑", async () => {
    const ok = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const bad = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await ollamaUp(ok)).toBe(true);
    expect(await ollamaUp(bad)).toBe(false);
  });

  test("ollamaModels：api/tags 的名字去掉 :tag 后缀；服务没起返回 null", async () => {
    const fn = (async () =>
      new Response(
        JSON.stringify({ models: [{ name: "bge-m3:latest" }, { name: "llama3.2:8b" }] }),
        { status: 200 }
      )) as unknown as typeof fetch;
    expect(await ollamaModels(fn)).toEqual(["bge-m3", "llama3.2"]);
    const down = (async () => {
      throw new Error("x");
    }) as unknown as typeof fetch;
    expect(await ollamaModels(down)).toBeNull();
  });

  test("pullOllamaModel：解析 NDJSON 流，收到 success 才算成功", async () => {
    const chunk = (s: string) => new TextEncoder().encode(s);
    const body = new ReadableStream({
      start(c) {
        c.enqueue(chunk('{"status":"pulling manifest"}\n{"status":"downloading digest","completed":50,"total":100}\n'));
        c.enqueue(chunk('{"status":"success"}\n'));
        c.close();
      },
    });
    const fn = (async () =>
      new Response(body, { status: 200 })) as unknown as typeof fetch;
    const seen: string[] = [];
    expect(await pullOllamaModel("bge-m3", (s) => seen.push(s.status), fn)).toBe(true);
    expect(seen).toEqual(["pulling manifest", "downloading digest", "success"]);
    // 流没走到 success = 失败
    const body2 = new ReadableStream({
      start(c) {
        c.enqueue(chunk('{"status":"pulling manifest"}\n'));
        c.close();
      },
    });
    const fn2 = (async () =>
      new Response(body2, { status: 200 })) as unknown as typeof fetch;
    expect(await pullOllamaModel("x", () => {}, fn2)).toBe(false);
  });

  test("formatPullStatus：带进度的行给百分比", () => {
    expect(formatPullStatus({ status: "downloading", completed: 5e6, total: 1e7 })).toContain("50%");
    expect(formatPullStatus({ status: "verifying sha256 digest" })).toBe("verifying sha256 digest");
  });
});
