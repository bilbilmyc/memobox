/** 真实磁盘库/长驻 MCP；模型缓存已准备，首次下载另由安装验收覆盖。 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { parseArgs } from "node:util";
import { createServer } from "node:http";
import { mcpClient, runProcess } from "./native/process.mjs";
import { processMemory } from "./native/process-memory.mjs";
import assert from "node:assert/strict";

const { values: args } = parseArgs({ options: { package: { type: "string" }, binary: { type: "string" }, vectors: { type: "string" }, out: { type: "string", default: "artifacts/performance/mcp-current.json" },
  sizes: { type: "string", default: "100,1000,10000" }, modes: { type: "string", default: "keyword,endpoint,local" }, repeats: { type: "string", default: "25" } } });
const root = mkdtempSync(join(tmpdir(), "memobox-mcp-performance-")), source = resolve(args.package ?? "."), version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
const bun = process.env.BUN_BINARY ?? (process.platform === "win32" ? join(homedir(), ".bun", "bin", "bun.exe") : "bun");
const command = args.binary ? resolve(args.binary) : bun, prefix = args.binary ? [] : [join(source, "src", "cli.ts")];
const vectors = resolve(args.vectors ?? "artifacts/quality/vectors-current.json"), sizes = args.sizes.split(",").map(Number), modes = args.modes.split(","), repeats = Number(args.repeats);
if (sizes.some(size => !Number.isSafeInteger(size) || size < 1 || size > 50000) || modes.some(mode => !["keyword", "endpoint", "local"].includes(mode)) || !Number.isInteger(repeats) || repeats < 5 || repeats > 100) throw Error("Invalid benchmark dimensions");
const dense = text => {
  let seed = Number(text.match(/topic(\d+)/)?.[1] ?? 0) % 512 + 1;
  return Array.from({ length: 512 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; });
};
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)], timings = values => ({ p50Ms: percentile(values, .5), p95Ms: percentile(values, .95) });
const scenarios = [];
for (const size of sizes) for (const mode of modes) {
  const home = join(root, `${size}-${mode}`); mkdirSync(join(home, ".memobox"), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, MEMOBOX_DB_PATH: join(home, "中文基准.db"), MEMOBOX_CONFIG_PATH: join(home, "配置.json"),
    MEMOBOX_RUNTIME_PATH: resolve("."), MEMOBOX_MODELS_PATH: join(homedir(), ".memobox", "models") };
  for (const name of Object.keys(env)) if (name.startsWith("EMBEDDING_") || name === "MEMOBOX_BACKEND" || name === "BUN_BE_BUN") delete env[name];
  // 旧版只能使用默认模型缓存位置；临时 home 仅链接已有公开模型，不包含用户库。
  if (!args.binary && mode === "local") symlinkSync(env.MEMOBOX_MODELS_PATH, join(home, ".memobox", "models"), process.platform === "win32" ? "junction" : "dir");
  let server, base, endpointRequests = 0, endpointWorkMs = 0;
  if (mode === "endpoint") {
    server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()), start = performance.now(), embedding = dense(body.input);
      endpointWorkMs += performance.now() - start; endpointRequests++;
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ embedding }] }));
    });
    await new Promise(done => server.listen(0, "127.0.0.1", done)); base = `http://127.0.0.1:${server.address().port}/v1`;
    Object.assign(env, { EMBEDDING_API_BASE: base, EMBEDDING_MODEL: "benchmark-dense", EMBEDDING_DIM: "512" });
  } else if (mode === "local") writeFileSync(env.MEMOBOX_CONFIG_PATH, JSON.stringify({ embedding: { local: true, model: "Xenova/bge-small-zh-v1.5" } }));
  const seeded = JSON.parse((await runProcess(bun, [resolve("scripts/seed-benchmark.ts"), "--package", source, "--size", String(size), "--mode", mode, "--db", env.MEMOBOX_DB_PATH,
    ...(base ? ["--base", base] : []), ...(mode === "local" ? ["--vectors", vectors] : [])], { env: { ...env, MEMOBOX_CONFIG_PATH: join(home, "seed-no-config.json") }, cwd: source, timeout: 120000 })).stdout);
  const started = performance.now(), a = mcpClient(command, prefix, env);
  let b;
  try {
    const initialized = await a.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "benchmark", version: "1" } }); assert.equal(initialized.serverInfo.version, version);
    const initializeMs = performance.now() - started, coldAt = performance.now(), queries = mode === "local" ? ["共享记忆", "SSH authentication", "zzzz_unique_absent"] : ["开发环境", "topic17", "zzzz_unique_absent"];
    const coldResult = await a.tool("memory_search", { query: queries[0], limit: 5 }, 240000); assert(!coldResult.isError);
    const firstSearchMs = performance.now() - coldAt, coldMemory = processMemory(a.child.pid), cases = [];
    for (const query of queries) {
      const samples = [];
      for (let repeat = 0; repeat < repeats; repeat++) {
        const at = performance.now(), result = await a.tool("memory_search", { query, limit: 5 }); assert(!result.isError); samples.push(performance.now() - at);
      }
      cases.push({ query, ...timings(samples) });
    }
    const uncached = [];
    if (mode === "local") for (let repeat = 0; repeat < repeats; repeat++) {
      const at = performance.now(); const result = await a.tool("memory_search", { query: "共享记忆，未缓存查询编号 " + repeat }); assert(!result.isError); uncached.push(performance.now() - at);
    }
    const warmMemory = processMemory(a.child.pid);
    b = mcpClient(command, prefix, env); await b.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "concurrent-benchmark", version: "1" } });
    await b.tool("memory_search", { query: queries[0] }, 240000);
    const contention = [], writes = []; let coldWriteMs, coldConcurrentMs;
    for (let repeat = 0; repeat < repeats + 5; repeat++) {
      const at = performance.now();
      const [read, saved] = await Promise.all([a.tool("memory_search", { query: queries[0] }), b.tool("memory_save", { content: "concurrent_benchmark 独立写入 " + repeat, source: "benchmark-concurrency" })]);
      assert(!read.isError && !saved.isError); const concurrentMs = performance.now() - at;
      const writeAt = performance.now(); const next = await a.tool("memory_save", { content: "benchmark_write 保存 " + repeat }); assert(!next.isError); const writeMs = performance.now() - writeAt;
      if (!repeat) { coldWriteMs = writeMs; coldConcurrentMs = concurrentMs; }
      if (repeat >= 5) { contention.push(concurrentMs); writes.push(writeMs); }
    }
    assert((await a.tool("memory_search", { query: "concurrent_benchmark" })).content[0].text.includes("独立写入"));
    assert(!/语义检索失败|嵌入失败/.test(a.diagnostics() + b.diagnostics()), "Model fallback invalidates the semantic benchmark");
    const peakMemory = processMemory(a.child.pid);
    const scenario = { size, mode, importMs: seeded.importMs, initializeMs, firstSearchMs, coldWriteMs, coldConcurrentMs, cases, concurrentReadWrite: timings(contention), writes: timings(writes),
      coldMemory, warmMemory, peakMemory, ...(mode === "local" ? { uncachedModelQueries: timings(uncached), repeatedQueriesUseModelCache: Boolean(args.binary) } : {}),
      ...(mode === "endpoint" ? { endpoint: { kind: "real local HTTP with deterministic dense vectors; no real model", requests: endpointRequests, computeMsPerRequest: endpointWorkMs / endpointRequests } } : {}) };
    scenarios.push(scenario); console.error(JSON.stringify({ size, mode, initializeMs, firstSearchMs, p95Ms: cases.map(row => row.p95Ms), peakBytes: peakMemory.peakBytes }));
  } finally { await a.close(); if (b) await b.close(); if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); } }
}
const report = { version, platform: process.platform, arch: process.arch, runtime: args.binary ? "compiled CLI" : "Bun source package", sizes, repeats, writeWarmups: 5,
  model: "BGE q8 real model and cached exact synthetic document vectors for local mode; endpoint mode isolates HTTP/ranking costs. No user memories.", scenarios };
const output = resolve(args.out); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ version, output, scenarios: scenarios.length }));
