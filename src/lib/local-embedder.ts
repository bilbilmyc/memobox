/**
 * 进程内嵌入模型（v2.5 轻量语义方案）：
 * transformers.js + 量化 ONNX 小模型（默认 bge-small-zh-v1.5，约 25MB，
 * 512 维，中英都好使），CPU/WASM 推理——无服务、无端口、无 Ollama。
 *
 * 重量控制：transformers.js 只在第一次真正 embed 时才动态 import，
 * keyword 模式的进程（绝大多数 MCP 拉起）完全不加载它。
 * 模型缓存在 ~/.memobox/models；国内默认走 hf-mirror.com，
 * 可用 HF_ENDPOINT 换源（如 https://huggingface.co）。
 */
import type { EmbeddingProvider } from "./embeddings";
import { pathToFileURL } from "node:url";
import { IS_COMPILED } from "../runtime";
import { localRuntimeEntry, modelCachePath } from "./optional-runtime";
import { createLocalModelProcess } from "./local-model-process";

export const LOCAL_EMBED_MODEL = "Xenova/bge-small-zh-v1.5";
export const LOCAL_EMBED_DIM = 512;

/** 模型源：hf-mirror 优先（国内直连 huggingface.co 不通），失败自动换下一个 */
const HF_HOSTS = ["https://hf-mirror.com", "https://huggingface.co"];

type Extractor = (
  text: string,
  opts: { pooling: "cls"; normalize: boolean }
) => Promise<{ data: Float32Array }>;

/** 模块级单例：同一进程里 probe/补算/store 共用一个加载好的模型 */
let extractorPromise: Promise<Extractor> | null = null;
let modelProcess: ReturnType<typeof createLocalModelProcess> | null = null;

async function loadExtractor(
  onProgress?: (msg: string) => void
): Promise<Extractor> {
  const external = IS_COMPILED || Boolean(process.env.MEMOBOX_RUNTIME_PATH);
  const entry = external ? localRuntimeEntry() : null;
  if (external && !entry) throw Error("Cannot find package '@huggingface/transformers'");
  const { pipeline, env } = external ? await import(pathToFileURL(entry!).href) as typeof import("@huggingface/transformers") : await import("@huggingface/transformers");
  env.cacheDir = modelCachePath();
  // 显式 HF_ENDPOINT 最优先（海外用户指回官方源）
  const first = process.env.HF_ENDPOINT;
  const hosts = first
    ? [first, ...HF_HOSTS.filter((h) => h !== first)]
    : HF_HOSTS;
  let lastErr: unknown;
  for (const host of hosts) {
    try {
      env.remoteHost = host;
      onProgress?.(`从 ${host} 加载模型（首次约 25MB，之后走本地缓存）…`);
      const pipe = await pipeline("feature-extraction", LOCAL_EMBED_MODEL, {
        dtype: "q8",
      });
      return pipe as unknown as Extractor;
    } catch (e) {
      lastErr = e;
      onProgress?.(`${host} 加载失败，换下一个源`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 内置模型 provider；embed 时才惰性加载模型（构造零开销） */
export function createLocalEmbedder(
  onProgress?: (msg: string) => void
): EmbeddingProvider {
  async function embed(text: string): Promise<number[]> {
      if (IS_COMPILED) {
        if (!localRuntimeEntry()) throw Error("Cannot find package '@huggingface/transformers'");
        modelProcess ??= createLocalModelProcess(onProgress);
        return modelProcess.embed(text);
      }
      if (!extractorPromise) {
        // 失败要能重试：清掉缓存的 promise
        extractorPromise = loadExtractor(onProgress).catch((e) => {
          extractorPromise = null;
          throw e;
        });
      }
      const extract = await extractorPromise;
      const out = await extract(text, { pooling: "cls", normalize: true });
      return Array.from(out.data);
  }
  return {
    model: LOCAL_EMBED_MODEL, dimensions: LOCAL_EMBED_DIM,
    space: "transformers-feature-extraction-v2:cls:query-instruction:normalize:q8",
    // 在训练集上固定；不把内置模型的分布阈值套给其他端点模型。
    minimumSimilarity: 0.45,
    embed,
    embedQuery: text => embed("为这个句子生成表示以用于检索相关文章：" + text),
  };
}

/** 仅测试用：清掉模型单例，让下一个用例可以注入假的 transformers */
export function resetLocalExtractor(): void {
  extractorPromise = null;
  modelProcess?.stop(); modelProcess = null;
}

/**
 * 识别「transformers 未安装」的加载失败（v2.6.1 起它不在 npm 包的
 * dependencies 里——发布版默认轻量，lite 用户按需补装）。
 * Bun 与 Node 的动态 import 缺包都抛含这段文案的错误。
 */
export function isTransformersMissing(e: unknown): boolean {
  return (
    e instanceof Error &&
    e.message.includes("Cannot find package '@huggingface/transformers'")
  );
}
