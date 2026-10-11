import { afterEach, describe, expect, test } from "bun:test";
import { createEmbedder, openAICompatibleEmbedder } from "./embeddings";

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

  afterEach(() => {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  test("returns null without base/key", () => {
    delete process.env.EMBEDDING_API_BASE;
    delete process.env.EMBEDDING_API_KEY;
    expect(createEmbedder()).toBeNull();
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
