import { test, expect } from "bun:test";
import { openAICompatibleEmbedder, createEmbedder } from "./embeddings";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";

test("文件端点模式下环境变量模型与密钥也优先，非法超时和维度在请求前报错", async () => {
  let calls = 0, receivedModel = "", receivedKey = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++; receivedKey = request.headers.get("authorization") ?? "";
    receivedModel = ((await request.json()) as { model: string }).model;
    return Response.json({ data: [{ embedding: [1, 0] }] });
  } });
  const root = mkdtempSync(join(tmpdir(), "memobox-env-config-")), path = join(root, "config.json");
  const names = ["MEMOBOX_CONFIG_PATH", "EMBEDDING_API_BASE", "EMBEDDING_MODEL", "EMBEDDING_API_KEY", "EMBEDDING_DIM", "EMBEDDING_TIMEOUT_MS"];
  const previous = names.map(name => process.env[name]);
  try {
    writeFileSync(path, JSON.stringify({ embedding: { base: "http://127.0.0.1:" + server.port, model: "file-model", key: "file-key", dimensions: 2 } }));
    names.forEach(name => delete process.env[name]);
    process.env.MEMOBOX_CONFIG_PATH = path; process.env.EMBEDDING_MODEL = "environment-model"; process.env.EMBEDDING_API_KEY = "environment-key";
    await createEmbedder()!.embed("配置优先级");
    expect(receivedModel).toBe("environment-model");
    expect(receivedKey).toBe("Bearer environment-key");
    process.env.EMBEDDING_TIMEOUT_MS = "NaN";
    expect(() => createEmbedder()).toThrow();
    delete process.env.EMBEDDING_TIMEOUT_MS; process.env.EMBEDDING_DIM = "-1";
    expect(() => createEmbedder()).toThrow();
    expect(calls).toBe(1);
  } finally {
    server.stop(true);
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("memobox-env-config-")) throw Error("测试目录越界");
    rmSync(root, { recursive: true, force: true });
  }
});

test("真实挂起的嵌入端点会被超时终止，调用不会永久卡住", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Promise<Response>(() => {}); } });
  const provider = openAICompatibleEmbedder({ base: "http://127.0.0.1:" + server.port, model: "test", dimensions: 2, timeoutMs: 100 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([provider.embed("超时回归").then(() => "unexpected-success", () => "aborted"),
      new Promise<string>(done => { timer = setTimeout(() => done("hung"), 1500); })]);
    expect(result).toBe("aborted");
  } finally { clearTimeout(timer); server.stop(true); }
});

test("配置中的向量维度被工厂使用，环境变量维度优先", () => {
  const root = mkdtempSync(join(tmpdir(), "memobox-dimensions-")), path = join(root, "config.json");
  const names = ["MEMOBOX_CONFIG_PATH", "EMBEDDING_API_BASE", "EMBEDDING_DIM"];
  const previous = names.map(name => process.env[name]);
  try {
    writeFileSync(path, JSON.stringify({ embedding: { base: "https://example.invalid/v1", dimensions: 512 } }));
    process.env.MEMOBOX_CONFIG_PATH = path; delete process.env.EMBEDDING_API_BASE; delete process.env.EMBEDDING_DIM;
    expect(createEmbedder()?.dimensions).toBe(512);
    process.env.EMBEDDING_DIM = "1024";
    expect(createEmbedder()?.dimensions).toBe(1024);
  } finally {
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("memobox-dimensions-")) throw Error("测试目录越界");
    rmSync(root, { recursive: true, force: true });
  }
});
