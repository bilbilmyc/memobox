/** 向独立临时库灌入基准数据；不读用户记忆。真实模型模式复用已生成的合成文本向量。 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SQLiteStore } from "../src/db/sqlite-store";
import type { EmbeddingProvider } from "../src/lib/embeddings";
const args = parseArgs({ options: { package: { type: "string" }, db: { type: "string" }, size: { type: "string" }, mode: { type: "string" }, base: { type: "string" }, vectors: { type: "string" } } }).values;
const packageRoot = resolve(args.package!), size = Number(args.size);
if (!args.db || !Number.isInteger(size) || size < 1 || size > 50000 || !["keyword", "endpoint", "local"].includes(args.mode!)) throw Error("Invalid seed arguments");
const Store = (await import(pathToFileURL(join(packageRoot, "src/db/sqlite-store.ts")).href)).SQLiteStore as typeof SQLiteStore;
const dense = (text: string) => {
  let seed = Number(text.match(/topic(\d+)/)?.[1] ?? 0) % 512 + 1;
  return Array.from({ length: 512 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; });
};
const cache = args.mode === "local" ? JSON.parse(readFileSync(args.vectors!, "utf8")) : null;
const fixture = args.mode === "local" ? JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/retrieval-bilingual.json"), "utf8")) : null;
const provider: EmbeddingProvider | null = args.mode === "keyword" ? null : { model: cache?.model ?? "benchmark-dense", dimensions: 512,
  space: cache?.space ?? `openai-compatible-v1:${args.base}`, async embed(text) { return cache ? cache.vectors[text] : dense(text); } };
const store = new Store(provider, args.db);
const started = performance.now();
try {
  await store.importMemories(Array.from({ length: size }, (_, i) => ({ id: "bench-" + i,
    content: cache ? fixture.memories[i % fixture.memories.length].content : "项目开发环境的端口偏好、Windows 配置和中文检索。topic" + (i % 512) + " 独特编号" + i,
    kind: "fact", source: "synthetic-benchmark", entities: ["项目" + (i % 100), "开发环境"], createdAt: i + 1 })));
  console.log(JSON.stringify({ size, mode: args.mode, importMs: performance.now() - started, ...(cache ? { model: cache.model, vectorSource: "real synthetic corpus; repeated exact content" } : {}) }));
} finally { store.close(); }
