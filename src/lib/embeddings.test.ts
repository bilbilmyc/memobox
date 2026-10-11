import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbedder, openAICompatibleEmbedder, probeOllama } from "./embeddings";
import { saveConfig } from "./config";

describe("openAICompatibleEmbedder", () => {
  test("posts to {base}/embeddings and parses the vector", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        init: init ?? {},
      });
      return new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const embedder = openAICompatibleEmbedder({
      base: "https://api.example.com/v1/",
      key: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 1536,
      fetchFn,
    });

    const vec = await embedder.embed("hello world");
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.example.com/v1/embeddings");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      model: "text-embedding-3-small",
      input: "hello world",
    });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-test"
    );
  });

  test("无 key（本地 Ollama 场景）不送 authorization 头", async () => {
    const calls: { init: RequestInit }[] = [];
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init ?? {} });
      return new Response(JSON.stringify({ data: [{ embedding: [0.5] }] }), {
        status: 200,
      });
    }) as typeof fetch;

    const embedder = openAICompatibleEmbedder({
      base: "http://localhost:11434/v1",
      model: "bge-m3",
      dimensions: 1024,
      fetchFn,
    });

    expect(await embedder.embed("你好")).toEqual([0.5]);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
  });

  test("throws a readable error on non-ok responses", async () => {
    const fetchFn = (async () =>
      new Response("quota exceeded", { status: 429 })) as unknown as typeof fetch;
    const embedder = openAICompatibleEmbedder({
      base: "https://api.example.com/v1",
      key: "k",
      model: "m",
      dimensions: 8,
      fetchFn,
    });
    expect(embedder.embed("x")).rejects.toThrow("embedding api 429");
  });

  test("throws when the response has no vector", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ data: [] }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const embedder = openAICompatibleEmbedder({
      base: "https://api.example.com/v1",
      key: "k",
      model: "m",
      dimensions: 8,
      fetchFn,
    });
    expect(embedder.embed("x")).rejects.toThrow("no vector");
  });
});

describe("createEmbedder", () => {
  const keys = ["EMBEDDING_API_BASE", "EMBEDDING_API_KEY", "EMBEDDING_MODEL"];
  const original: Record<string, string | undefined> = {};
  for (const k of keys) original[k] = process.env[k];
  // 配置文件是第二来源（v2.4）——测试统一指到临时路径，隔离真机的 ~/.memobox/config.json
  const CFG = join(tmpdir(), "memobox-emb-test-config.json");

  afterEach(() => {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    delete process.env.MEMOBOX_CONFIG_PATH;
    rmSync(CFG, { force: true });
  });

  test("没有 BASE 就返回 null（KEY 单独存在也没用）", () => {
    process.env.MEMOBOX_CONFIG_PATH = CFG;
    delete process.env.EMBEDDING_API_BASE;
    process.env.EMBEDDING_API_KEY = "sk-x";
    expect(createEmbedder()).toBeNull();
  });

  test("只配 BASE（本地端点免鉴权）也建出 provider", () => {
    process.env.MEMOBOX_CONFIG_PATH = CFG;
    delete process.env.EMBEDDING_API_KEY;
    process.env.EMBEDDING_API_BASE = "http://localhost:11434/v1";
    process.env.EMBEDDING_MODEL = "bge-m3";
    expect(createEmbedder()?.model).toBe("bge-m3");
  });

  test("配置文件的 embedding 段也能启用（memobox model enable 写的路径）", () => {
    process.env.MEMOBOX_CONFIG_PATH = CFG;
    delete process.env.EMBEDDING_API_BASE;
    saveConfig({ embedding: { base: "http://localhost:11434/v1", model: "bge-m3" } }, CFG);
    expect(createEmbedder()?.model).toBe("bge-m3");
  });

  test("env 优先于配置文件", () => {
    process.env.MEMOBOX_CONFIG_PATH = CFG;
    process.env.EMBEDDING_API_BASE = "https://api.openai.com/v1";
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    saveConfig({ embedding: { base: "http://localhost:11434/v1", model: "bge-m3" } }, CFG);
    expect(createEmbedder()?.model).toBe("text-embedding-3-small");
  });

  test("配置文件 local 段启用内置模型（构造不触发模型加载）", () => {
    process.env.MEMOBOX_CONFIG_PATH = CFG;
    delete process.env.EMBEDDING_API_BASE;
    saveConfig({ embedding: { local: true } }, CFG);
    const p = createEmbedder();
    expect(p?.model).toBe("Xenova/bge-small-zh-v1.5");
    expect(p?.dimensions).toBe(512);
  });
});

describe("probeOllama", () => {
  const res = (ids: string[]) =>
    new Response(
      JSON.stringify({ data: ids.map((id) => ({ id })) }),
      { status: 200 }
    );

  test("有嵌入类模型时优先推荐它", async () => {
    const fetchFn = (async () =>
      res(["llama3.2", "bge-m3"])) as unknown as typeof fetch;
    expect(await probeOllama(fetchFn)).toBe("bge-m3");
  });

  test("没有嵌入类模型退回第一个；空列表 / 请求失败返回 null", async () => {
    const only = (async () => res(["llama3.2"])) as unknown as typeof fetch;
    expect(await probeOllama(only)).toBe("llama3.2");
    const empty = (async () => res([])) as unknown as typeof fetch;
    expect(await probeOllama(empty)).toBeNull();
    const dead = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await probeOllama(dead)).toBeNull();
  });

  test("builds a provider from env", () => {
    process.env.EMBEDDING_API_BASE = "https://api.openai.com/v1";
    process.env.EMBEDDING_API_KEY = "sk-x";
    delete process.env.EMBEDDING_MODEL;
    const p = createEmbedder();
    expect(p?.model).toBe("text-embedding-3-small");
    expect(p?.dimensions).toBe(1536);
  });
});
