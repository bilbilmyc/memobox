/** 用真实量化模型生成固定集向量；模型下载/推理与本地检索耗时分开记录。 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { createLocalEmbedder, LOCAL_EMBED_MODEL } from "../src/lib/local-embedder";
import { modelCachePath } from "../src/lib/optional-runtime";

const args = parseArgs({ options: { split: { type: "string", default: "training" }, fixture: { type: "string" }, pipeline: { type: "string", default: "current" }, out: { type: "string", default: "artifacts/quality/vectors-current.json" } } }).values;
if (!["training", "heldout"].includes(args.split!)) throw Error("split must be training or heldout");
const bytes = readFileSync(args.fixture ?? resolve(import.meta.dir, "fixtures/retrieval-bilingual.json"), "utf8").replace(/\r\n/g, "\n"), fixture = JSON.parse(bytes);
const fixtureSha256 = createHash("sha256").update(bytes).digest("hex"), output = resolve(args.out!);
if (!["legacy", "current"].includes(args.pipeline!)) throw Error("pipeline must be legacy or current");
const current = createLocalEmbedder(message => console.error(message)), legacy = args.pipeline === "legacy";
let cache: { model: string; dimensions: number; fixtureSha256: string; space: string; minimumSimilarity: number; vectors: Record<string, number[]>; queryVectors: Record<string, number[]>; timings: { textSha256: string; ms: number; split: string; role: string }[] } =
  { model: LOCAL_EMBED_MODEL, dimensions: 512, fixtureSha256, space: legacy ? "transformers-feature-extraction-v1:mean:normalize:q8" : current.space!, minimumSimilarity: legacy ? .35 : current.minimumSimilarity!, vectors: {}, queryVectors: {}, timings: [] };
if (existsSync(output)) { const previous = JSON.parse(readFileSync(output, "utf8")); if (previous.model === cache.model && previous.fixtureSha256 === fixtureSha256 && previous.space === cache.space) cache = previous; }
const rows = fixture.memories.filter((row: { id: string }) => row.id.startsWith(args.split === "training" ? "t-" : "h-"));
let legacyExtract: ((text: string, options: { pooling: "mean"; normalize: true }) => Promise<{ data: Float32Array }>) | undefined;
const documents = [...new Set<string>(rows.map((row: { content: string }) => row.content))], queries = [...new Set<string>(fixture[args.split!].map((row: { query: string }) => row.query))];
for (const [role, texts] of [["document", documents], ["query", queries]] as const) for (const text of texts) {
  const target = role === "query" ? cache.queryVectors : cache.vectors;
  if (target[text]) continue;
  if (legacy && !legacyExtract) {
    const { pipeline, env } = await import("@huggingface/transformers"); env.cacheDir = modelCachePath(); env.remoteHost = process.env.HF_ENDPOINT || "https://hf-mirror.com";
    legacyExtract = await pipeline("feature-extraction", LOCAL_EMBED_MODEL, { dtype: "q8" }) as unknown as typeof legacyExtract;
  }
  const start = performance.now(), vector = legacy ? Array.from((await legacyExtract!(text, { pooling: "mean", normalize: true })).data)
    : await (role === "query" ? current.embedQuery! : current.embed)(text);
  if (vector.length !== 512 || vector.some(value => !Number.isFinite(value))) throw Error("Invalid real-model output");
  target[text] = vector; cache.timings.push({ textSha256: createHash("sha256").update(text).digest("hex"), ms: performance.now() - start, split: args.split!, role });
}
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(cache));
console.log(JSON.stringify({ model: cache.model, space: cache.space, split: args.split, texts: documents.length + queries.length, fixtureSha256, output }));
