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
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "./embeddings";

export const LOCAL_EMBED_MODEL = "Xenova/bge-small-zh-v1.5";
export const LOCAL_EMBED_DIM = 512;

/** 模型源：hf-mirror 优先（国内直连 huggingface.co 不通），失败自动换下一个 */
const HF_HOSTS = ["https://hf-mirror.com", "https://huggingface.co"];

type Extractor = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array }>;

/** 模块级单例：同一进程里 probe/补算/store 共用一个加载好的模型 */
let extractorPromise: Promise<Extractor> | null = null;

async function loadExtractor(
  onProgress?: (msg: string) => void
): Promise<Extractor> {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = join(homedir(), ".memobox", "models");
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
  return {
    model: LOCAL_EMBED_MODEL,
    dimensions: LOCAL_EMBED_DIM,
    async embed(text: string): Promise<number[]> {
      if (!extractorPromise) {
        // 失败要能重试：清掉缓存的 promise
        extractorPromise = loadExtractor(onProgress).catch((e) => {
          extractorPromise = null;
          throw e;
        });
      }
      const extract = await extractorPromise;
      const out = await extract(text, { pooling: "mean", normalize: true });
      return Array.from(out.data);
    },
  };
}

/** 仅测试用：清掉模型单例，让下一个用例可以注入假的 transformers */
export function resetLocalExtractor(): void {
  extractorPromise = null;
}
