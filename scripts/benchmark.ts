/** 本地可重复的性能基线：合成中文记忆，不触碰用户库或配置。 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SQLiteStore } from "../src/db/sqlite-store";
import type { EmbeddingProvider } from "../src/lib/embeddings";

const args = parseArgs({ options: { out: { type: "string" }, package: { type: "string" }, dense: { type: "boolean" }, "unique-entities": { type: "boolean" }, sizes: { type: "string", default: "100,1000,10000" } } }).values;
const packageRoot = args.package ? resolve(args.package) : resolve(import.meta.dir, "..");
// 每个版本用自己的 tsconfig 和工作目录启动，避免 @/ 别名混用工作区模块。
if (!process.env.MEMOBOX_BENCH_CHILD) {
  const forwarded = ["--sizes", args.sizes!, ...(args.package ? ["--package", packageRoot] : []),
    ...(args.out ? ["--out", resolve(args.out)] : []), ...(args.dense ? ["--dense"] : []), ...(args["unique-entities"] ? ["--unique-entities"] : [])];
  const child = Bun.spawn([process.execPath, import.meta.path, ...forwarded], {
    cwd: packageRoot, env: { ...process.env, MEMOBOX_BENCH_CHILD: "1" }, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  process.exit(await child.exited);
}
const Store = (await import(pathToFileURL(join(packageRoot, "src/db/sqlite-store.ts")).href)).SQLiteStore as typeof SQLiteStore;
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
const sizes = args.sizes!.split(",").map(Number);
if (sizes.some(n => !Number.isSafeInteger(n) || n < 1 || n > 100000)) throw Error("规模必须是 1–100000 的整数");
const provider: EmbeddingProvider = { model: "benchmark-deterministic", dimensions: 512, async embed(text) {
  const topic = Number(text.match(/topic(\d+)/)?.[1] ?? 0) % 512;
  if (args.dense) {
    let seed = topic + 1;
    return Array.from({ length: 512 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; });
  }
  const vector = new Array(512).fill(0); vector[topic] = 1; return vector;
} };
const percentile = (values: number[], p: number) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length*p)-1)];
const scenarios = [];
for (const size of sizes) {
  for (const semantic of [false, true]) {
    const store = new Store(semantic ? provider : null, ":memory:");
    try {
      const start = performance.now();
      await store.importMemories(Array.from({ length: size }, (_, i) => ({ id: "bench-" + i,
        content: "项目开发环境的端口偏好、Windows 配置和中文检索。topic" + (i % 512) + " 独特编号" + i,
        kind: "fact", source: "synthetic", entities: ["项目" + (args["unique-entities"] ? i : i % 100), "开发环境"], createdAt: i + 1 })));
      const importMs = performance.now() - start;
      const cold = performance.now(); await store.search("独特编号" + (size - 1), 5);
      const coldSearchMs = performance.now() - cold;
      const cases = [];
      for (const query of ["独特编号" + (size - 1), "开发环境", "topic17", "不存在的检索zzzz", "zzzz_unique_absent"]) {
        const samples = [];
        for (let repeat = 0; repeat < 40; repeat++) {
          const at = performance.now(); await store.search(query, 5); samples.push(performance.now()-at);
        }
        cases.push({ query, p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95) });
      }
      scenarios.push({ size, mode: semantic ? "hybrid" : "keyword", importMs, coldSearchMs, cases, rssBytes: process.memoryUsage().rss });
    } finally { store.close(); }
  }
}
const report = { version, denseVectors: Boolean(args.dense), uniqueEntities: Boolean(args["unique-entities"]), bun: Bun.version, platform: process.platform, arch: process.arch,
  data: "synthetic Chinese; 512-dimensional deterministic provider; in-memory SQLite; no network; RSS is cumulative per-process snapshot, not a per-store peak", scenarios };
if (args.out) { mkdirSync(dirname(args.out), { recursive: true }); writeFileSync(args.out, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ version, scenarios: scenarios.map(s => ({ size: s.size, mode: s.mode, importMs: s.importMs, coldMs: s.coldSearchMs, p95Ms: s.cases.map(c => c.p95Ms) })) }, null, 2));
