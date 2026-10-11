/**
 * Embedding provider。任何 OpenAI 兼容的 /embeddings 端点都能用
 * （OpenAI、SiliconFlow 的 bge-m3、Ollama 兼容层……）。
 * KEY 可不配——本地 Ollama 无鉴权，只设 BASE 即可。
 * 没配置时 store 回退为关键词检索（默认零配置可用）。
 */

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

export function openAICompatibleEmbedder(
  opts: {
    base: string;
    key?: string;
    model: string;
    dimensions: number;
    /** 测试注入用 */
    fetchFn?: typeof fetch;
  }
): EmbeddingProvider {
  const doFetch = opts.fetchFn ?? fetch;
  const base = opts.base.replace(/\/$/, "");
  return {
    model: opts.model,
    dimensions: opts.dimensions,
    async embed(text: string): Promise<number[]> {
      const res = await doFetch(`${base}/embeddings`, {
        method: "POST",
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

/** 环境变量驱动的工厂；只设 EMBEDDING_API_BASE 即启用（KEY 可选，本地端点免鉴权） */
export function createEmbedder(): EmbeddingProvider | null {
  const base = process.env.EMBEDDING_API_BASE;
  if (!base) return null;
  return openAICompatibleEmbedder({
    base,
    key: process.env.EMBEDDING_API_KEY,
    model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    dimensions: Number(process.env.EMBEDDING_DIM ?? 1536),
  });
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
