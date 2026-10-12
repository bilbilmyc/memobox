/** 固定合成验收集，衡量检索结果而不是用运行时生成“正确答案”。 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import type { SQLiteStore } from "../src/db/sqlite-store";
import type { KeywordIndex, Memory } from "../src/lib/memory";

const args = parseArgs({ options: { package: { type: "string" }, out: { type: "string" } } }).values;
const packageRoot = args.package ? resolve(args.package) : resolve(import.meta.dir, "..");
if (!process.env.MEMOBOX_EVAL_CHILD) {
  const forwarded = [...(args.package ? ["--package", packageRoot] : []), ...(args.out ? ["--out", resolve(args.out)] : [])];
  const child = Bun.spawn([process.execPath, import.meta.path, ...forwarded], {
    cwd: packageRoot, env: { ...process.env, MEMOBOX_EVAL_CHILD: "1" }, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  process.exit(await child.exited);
}
const fixtureBytes = readFileSync(join(import.meta.dir, "fixtures/retrieval.json"));
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  description: string; memories: Memory[]; queries: { id: string; category: string; query: string; relevant: string[] }[];
};
const Store = (await import(pathToFileURL(join(packageRoot, "src/db/sqlite-store.ts")).href)).SQLiteStore as typeof SQLiteStore;
const Index = (await import(pathToFileURL(join(packageRoot, "src/lib/memory.ts")).href)).KeywordIndex as typeof KeywordIndex;
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
const cutoff = 5, scenarios = [];
for (const mode of ["bm25", "keyword+graph"]) {
  const store = new Store(null, ":memory:"), index = new Index();
  try {
    await store.importMemories(fixture.memories); index.rebuild(fixture.memories);
    const cases = [];
    for (const item of fixture.queries) {
      const start = performance.now();
      const ranked = mode === "bm25" ? index.search(item.query, cutoff) : await store.search(item.query, cutoff);
      const ids = ranked.map(m => m.id), hitCount = ids.filter(id => item.relevant.includes(id)).length;
      const firstRelevant = ids.findIndex(id => item.relevant.includes(id));
      cases.push({ ...item, returned: ids, latencyMs: performance.now() - start,
        recallAt5: item.relevant.length ? hitCount / item.relevant.length : null,
        precisionAt5: hitCount / cutoff, reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1) });
    }
    const positives = cases.filter(c => c.relevant.length), negatives = cases.filter(c => !c.relevant.length);
    const mean = (values: number[]) => values.reduce((sum, n) => sum + n, 0) / values.length;
    scenarios.push({ mode, metrics: {
      recallAt5: mean(positives.map(c => c.recallAt5!)), precisionAt5: mean(positives.map(c => c.precisionAt5)),
      mrrAt5: mean(positives.map(c => c.reciprocalRank)),
      unrelatedRecallRate: negatives.filter(c => c.returned.length).length / negatives.length,
      positiveQueries: positives.length, unrelatedQueries: negatives.length,
    }, cases });
  } finally { store.close(); }
}
const report = { version, cutoff, fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
  data: fixture.description, limitations: "小型固定人工验收集；不代表真实用户分布。仅评测关键词和图谱；语义/RRF/真实模型及独立留出集尚未验收。Precision@5 固定以 5 为分母；无关查询单独计入 unrelatedRecallRate。单次延迟不能替代性能基准。", scenarios };
if (args.out) { mkdirSync(dirname(args.out), { recursive: true }); writeFileSync(args.out, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ version, fixtureSha256: report.fixtureSha256, scenarios: scenarios.map(s => ({ mode: s.mode, ...s.metrics })) }, null, 2));
