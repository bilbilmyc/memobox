import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { runCli } from "./cli";
import { encodeEmbedding } from "./db/sqlite-store";
import { embeddingSpace } from "./lib/embeddings";
import { defaultCliTools } from "./cli/model";
import { codexTomlBlock, piMerge } from "./install";

test("doctor JSON 只读检查旧库、向量缺失/损坏/空间/维度，保留数据库原始字节", async () => {
  const root = mkdtempSync(join(tmpdir(), "memobox-doctor-full-")), path = join(root, "legacy.db");
  const previous = { ...process.env }, out: string[] = [];
  const db = new Database(path);
  db.exec("CREATE TABLE memories(id TEXT PRIMARY KEY, content TEXT, kind TEXT, source TEXT, entities TEXT, embedding BLOB, embedding_space TEXT, created_at INTEGER, updated_at INTEGER); CREATE TABLE query_log(id TEXT)");
  const provider = { model: "diagnostic-fixture", dimensions: 2, space: "openai-compatible-v1:http://127.0.0.1:1/v1", async embed() { throw Error("诊断不应加载模型"); } };
  const insert = db.prepare("INSERT INTO memories VALUES (?, '合成中文记忆', 'fact', 'test', '[]', ?, ?, 1, 1)");
  insert.run("valid", encodeEmbedding([1, 0]), embeddingSpace(provider, 2));
  insert.run("missing", null, null); insert.run("corrupt", new Uint8Array([1]), null);
  insert.run("unknown", encodeEmbedding([1, 0]), null);
  insert.run("other", encodeEmbedding([1, 0]), "other-space");
  insert.run("dimension", encodeEmbedding([1, 0, 0]), embeddingSpace(provider, 3));
  insert.run("zero", encodeEmbedding([0, 0]), embeddingSpace(provider, 2));
  db.close(true);
  process.env.MEMOBOX_DB_PATH = path; process.env.MEMOBOX_CONFIG_PATH = join(root, "no-config.json");
  process.env.EMBEDDING_API_BASE = "http://127.0.0.1:1/v1"; process.env.EMBEDDING_MODEL = provider.model; process.env.EMBEDDING_DIM = "2";
  try {
    const before = readFileSync(path);
    expect(await runCli(["doctor", "--json"], { out: s => out.push(s), err: () => {} }, () => { throw Error("不能创建可写 store"); }, { ...defaultCliTools, clientHome: root })).toBe(0);
    const report = JSON.parse(out.pop()!);
    expect(report.database.integrity).toBe("ok");
    expect(report.database.total).toBe(7);
    expect(report.database.vectors).toMatchObject({ valid: 1, missing: 1, invalid: 2, unknownSpace: 1, incompatible: 1, dimensionMismatch: 1 });
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(await runCli(["doctor", "--json", "--strict"], { out: s => out.push(s), err: () => {} }, () => { throw Error("只读检查"); }, { ...defaultCliTools, clientHome: root })).toBe(1);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("memobox-doctor-full-")) throw Error("清理路径越界");
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test("doctor 区分同库、异库和坏客户端配置，凭据不出现在 JSON 中", async () => {
  const root = mkdtempSync(join(tmpdir(), "memobox-doctor-clients-")), previous = { ...process.env }, out: string[] = [];
  const db = join(root, "current.db"), config = join(root, "config.json");
  const tools = { ...defaultCliTools, clientHome: root, probeOllama: async () => null, ollamaVersion: async () => null };
  try {
    process.env.MEMOBOX_DB_PATH = db; process.env.MEMOBOX_CONFIG_PATH = config;
    delete process.env.EMBEDDING_API_BASE;
    const entry = { command: process.execPath, args: [], env: { MEMOBOX_DB_PATH: db, MEMOBOX_CONFIG_PATH: config, EMBEDDING_API_KEY: "private-fixture-key" } };
    mkdirSync(join(root, ".codex")); mkdirSync(join(root, ".pi", "agent"), { recursive: true });
    writeFileSync(join(root, ".codex", "config.toml"), codexTomlBlock(entry));
    writeFileSync(join(root, ".pi", "agent", "mcp.json"), JSON.stringify(piMerge({}, { ...entry, env: { ...entry.env, MEMOBOX_DB_PATH: join(root, "other.db") } })));
    writeFileSync(join(root, ".claude.json"), "bad json private-fixture-key");
    expect(await runCli(["doctor", "--json"], { out: s => out.push(s), err: () => {} }, () => { throw Error("不应建库"); }, tools)).toBe(0);
    const report = JSON.parse(out[0]);
    expect(report.database.exists).toBe(false);
    expect(report.clients[0]).toMatchObject({ configured: true, dbMatches: true, configMatches: true, commandExists: true });
    expect(report.clients[1]).toMatchObject({ configured: true, dbMatches: false });
    expect(report.clients[2].error).toBe("invalid_config");
    expect(out[0]).not.toContain("private-fixture-key");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("memobox-doctor-clients-")) throw Error("清理路径越界");
    rmSync(root, { recursive: true, force: true });
  }
});
