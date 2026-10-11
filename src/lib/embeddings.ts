/**
 * Embedding providers. Any OpenAI-compatible /embeddings endpoint works
 * (OpenAI, SiliconFlow bge-m3, Ollama's compat layer, ...). When no
 * provider is configured the store falls back to keyword retrieval.
 */

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

export function openAICompatibleEmbedder(
  opts: {
    base: string;
    key: string;
    model: string;
    dimensions: number;
    /** Injectable for tests. */
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
          authorization: `Bearer ${opts.key}`,
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

/** Env-driven factory; null (no EMBEDDING_API_BASE/KEY) → keyword mode. */
export function createEmbedder(): EmbeddingProvider | null {
  const base = process.env.EMBEDDING_API_BASE;
  const key = process.env.EMBEDDING_API_KEY;
  if (!base || !key) return null;
  return openAICompatibleEmbedder({
    base,
    key,
    model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    dimensions: Number(process.env.EMBEDDING_DIM ?? 1536),
  });
}
