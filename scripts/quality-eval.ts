import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import type { SQLiteStore } from "../src/db/sqlite-store";
import type { KeywordIndex, Memory } from "../src/lib/memory";
import type { EmbeddingProvider } from "../src/lib/embeddings";

const args = parseArgs({ options: { split: { type: "string", default: "training" }, vectors: { type: "string", default: "artifacts/quality/real-vectors.json" }, package: { type: "string" }, out: { type: "string" } } }).values;
if (!["training", "heldout"].includes(args.split!)) throw Error("Unknown evaluation split");
const packageRoot = args.package ? resolve(args.package) : resolve(import.meta.dir, "..");
if (!process.env.MEMOBOX_QUALITY_CHILD) {
  const forwarded = ["--split", args.split!, "--vectors", resolve(args.vectors!), ...(args.package ? ["--package", packageRoot] : []), ...(args.out ? ["--out", resolve(args.out)] : [])];
  const child = Bun.spawn([process.execPath, import.meta.path, ...forwarded], { cwd: packageRoot, env: { ...process.env, MEMOBOX_QUALITY_CHILD: "1" }, stdout: "inherit", stderr: "inherit" });
  process.exit(await child.exited);
}
type EvaluationQuery = { id: string; category: string; query: string; relevant: string[] };
const bytes = readFileSync(join(import.meta.dir, "fixtures/retrieval-bilingual.json")), fixture = JSON.parse(bytes.toString("utf8")) as { description: string; memories: Memory[]; training: EvaluationQuery[]; heldout: EvaluationQuery[] };
const queries = args.split === "training" ? fixture.training : fixture.heldout, rows = fixture.memories.filter(row => row.id.startsWith(args.split === "training" ? "t-" : "h-"));
const cache = JSON.parse(readFileSync(args.vectors!, "utf8")) as { model: string; dimensions: number; space?: string; minimumSimilarity?: number; fixtureSha256: string; vectors: Record<string, number[]>; queryVectors?: Record<string, number[]>; timings: { ms: number; split: string }[] };
const fixtureSha256 = createHash("sha256").update(bytes).digest("hex"); if (cache.fixtureSha256 !== fixtureSha256) throw Error("Evaluation vectors do not match immutable fixture");
const provider: EmbeddingProvider = { model: cache.model, dimensions: cache.dimensions, space: cache.space ?? "transformers-feature-extraction-v1:mean:normalize:q8", minimumSimilarity: cache.minimumSimilarity ?? .35,
  async embed(text) { const vector = cache.vectors[text] ?? cache.queryVectors?.[text]; if (!vector) throw Error("Real model document vector missing"); return vector; },
  async embedQuery(text) { const vector = cache.queryVectors?.[text] ?? cache.vectors[text]; if (!vector) throw Error("Real model query vector missing"); return vector; } };
const Store = (await import(pathToFileURL(join(packageRoot, "src/db/sqlite-store.ts")).href)).SQLiteStore as typeof SQLiteStore;
const module = await import(pathToFileURL(join(packageRoot, "src/lib/memory.ts")).href), Index = module.KeywordIndex as typeof KeywordIndex;
const index = new Index(); index.rebuild(rows); const store = new Store(provider, ":memory:"); await store.importMemories(rows);
const cosine = (a: number[], b: number[]) => { let dot = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; } return aa && bb ? dot / Math.sqrt(aa * bb) : 0; };
const mean = (values: number[]) => values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : 0;
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0;
const scenarios = [];
try {
  const thresholds = args.split === "training" ? [.35, .45, .5, .55, .6, .65, .7, .75, .8, .85, .9] : [provider.minimumSimilarity!];
  for (const mode of ["bm25", "semantic", "rrf", "hybrid+graph"]) for (const threshold of mode === "semantic" || mode === "rrf" ? thresholds : [null]) {
    const cases = [];
    for (const item of queries) {
      const started = performance.now(), keyword = index.search(item.query, 20), scores = rows.map(memory => ({ memory, score: cosine(cache.queryVectors?.[item.query] ?? cache.vectors[item.query], cache.vectors[memory.content]) })).sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt);
      const semantic = scores.filter(row => row.score >= (threshold ?? .35)).slice(0, 20).map(row => row.memory);
      const ranked: Memory[] = mode === "bm25" ? keyword.slice(0, 5) : mode === "semantic" ? semantic.slice(0, 5) : mode === "rrf" ? module.rrfFuse([keyword, semantic], 5) : await store.search(item.query, 5);
      const ids = ranked.map(row => row.id), hitCount = ids.filter(id => item.relevant.includes(id)).length, first = ids.findIndex(id => item.relevant.includes(id));
      cases.push({ ...item, returned: ids, latencyMs: performance.now() - started, recallAt5: item.relevant.length ? hitCount / item.relevant.length : null,
        precisionAt5: hitCount / 5, reciprocalRank: first < 0 ? 0 : 1 / (first + 1), bestRelevantCosine: Math.max(0, ...scores.filter(row => item.relevant.includes(row.memory.id)).map(row => row.score)), topCosine: scores[0]?.score ?? 0 });
    }
    const positives = cases.filter(row => row.relevant.length), negatives = cases.filter(row => !row.relevant.length);
    scenarios.push({ mode, threshold, metrics: { recallAt5: mean(positives.map(row => row.recallAt5!)), precisionAt5: mean(positives.map(row => row.precisionAt5)), mrrAt5: mean(positives.map(row => row.reciprocalRank)),
      unrelatedRecallRate: negatives.filter(row => row.returned.length).length / negatives.length, p50Ms: percentile(cases.map(row => row.latencyMs), .5), p95Ms: percentile(cases.map(row => row.latencyMs), .95) }, cases });
  }
} finally { store.close(); }
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
const report = { version, split: args.split, fixtureSha256, model: cache.model, dimensions: cache.dimensions, source: "Real q8 ONNX model outputs, reused identically across versions; local ranking excludes model time. Synthetic judged corpus; fixed Precision@5 denominator.",
  modelTimings: cache.timings.filter(row => row.split === args.split).map(row => row.ms), rssBytes: process.memoryUsage().rss, scenarios };
if (args.out) { mkdirSync(dirname(args.out), { recursive: true }); writeFileSync(args.out, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ version, split: args.split, scenarios: scenarios.map(row => ({ mode: row.mode, threshold: row.threshold, ...row.metrics })) }, null, 2));
