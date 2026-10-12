/**
 * Embedding provider。任何 OpenAI 兼容的 /embeddings 端点都能用
 * （OpenAI、SiliconFlow 的 bge-m3、Ollama 兼容层……）。
 * KEY 可不配——本地 Ollama 无鉴权，只设 BASE 即可。
 * 没配置时 store 回退为关键词检索（默认零配置可用）。
 */

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  /** 同模型名下区分端点和预处理版本；不包含 API 密钥。 */
  readonly space?: string;
  /** 本机模型可区分文档/查询编码；端点与自定义 provider 默认沿用 embed。 */
  readonly minimumSimilarity?: number;
  embed(text: string): Promise<number[]>;
  embedQuery?(text: string): Promise<number[]>;
}

import { createHash } from "node:crypto";
import { loadConfig, parseConfigValue } from "./config";
import { createLocalEmbedder } from "./local-embedder";

/** 指纹同时包含实际维度和配置维度，兼容端点返回的维度与默认值不同。 */
export function embeddingSpace(provider: EmbeddingProvider, dimensions: number): string {
  return createHash("sha256").update(JSON.stringify({
    model: provider.model, dimensions, configuredDimensions: provider.dimensions,
    pipeline: provider.space ?? "custom-v1",
  })).digest("hex");
}

export function openAICompatibleEmbedder(
  opts: {
    base: string;
    key?: string;
    model: string;
    dimensions: number;
    timeoutMs?: number;
    /** 测试注入用 */
    fetchFn?: typeof fetch;
  }
): EmbeddingProvider {
  parseConfigValue("embedding.base", opts.base);
  parseConfigValue("embedding.model", opts.model);
  parseConfigValue("embedding.dimensions", String(opts.dimensions));
  parseConfigValue("embedding.timeoutMs", String(opts.timeoutMs ?? 5000));
  const doFetch = opts.fetchFn ?? fetch;
  const base = opts.base.replace(/\/$/, "");
  return {
    model: opts.model,
    dimensions: opts.dimensions,
    space: `openai-compatible-v1:${base}`,
    async embed(text: string): Promise<number[]> {
      const res = await doFetch(`${base}/embeddings`, {
        method: "POST",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
        headers: {
          "content-type": "application/json",
          // 无 key 端点（本地 Ollama）不送 authorization
          ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
        },
        body: JSON.stringify({ model: opts.model, input: text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`embedding api ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as { data?: { embedding?: number[] }[] };
      const vec = json.data?.[0]?.embedding;
      if (!Array.isArray(vec)) {
        throw new Error("embedding api returned no vector");
      }
      return vec;
    },
  };
}

/**
 * 环境变量驱动的工厂。两处来源，env 优先：
 * 1. EMBEDDING_API_*（老用法；只设 BASE 即启用，KEY 可选——本地端点免鉴权）
 * 2. ~/.memobox/config.json 的 embedding 段（`memobox model enable` 写的，
 *    v2.4 起——这样被客户端拉起的 MCP 服务也能拿到配置，不用重装）
 */
export function createEmbedder(): EmbeddingProvider | null {
  if (process.env.EMBEDDING_API_BASE) {
    return openAICompatibleEmbedder({
      base: process.env.EMBEDDING_API_BASE,
      key: process.env.EMBEDDING_API_KEY,
      model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
      dimensions: Number(process.env.EMBEDDING_DIM ?? 1536),
      timeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS ?? 5000),
    });
  }
  const cfg = loadConfig().embedding;
  if (cfg?.base) {
    return openAICompatibleEmbedder({
      base: cfg.base,
      key: process.env.EMBEDDING_API_KEY ?? cfg.key,
      model: process.env.EMBEDDING_MODEL ?? cfg.model ?? "text-embedding-3-small",
      dimensions: Number(process.env.EMBEDDING_DIM ?? cfg.dimensions ?? 1536),
      timeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS ?? cfg.timeoutMs ?? 5000),
    });
  }
  // 内置小模型（model enable --lite）：构造零开销，模型在第一次 embed 才加载
  if (cfg?.local) return createLocalEmbedder();
  return null;
}

/**
 * 探测本机 Ollama（doctor 的「零成本语义检索」提示用）：
 * 返回推荐的嵌入模型名；没装 / 端口不通 / 没有模型都返回 null。
 * 只提示，绝不自动启用——升级语义检索必须用户自己设 env。
 */
export async function probeOllama(fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn("http://localhost:11434/v1/models", {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id?: string }[] };
    const models = (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id));
    if (models.length === 0) return null;
    // 优先挑名字像嵌入模型的（bge / m3 / embed / gte），否则退回第一个
    return models.find((m) => /embed|bge|m3|gte/i.test(m)) ?? models[0];
  } catch {
    return null; // 没装 Ollama 或端口不通——正常情况，静默返回
  }
}
