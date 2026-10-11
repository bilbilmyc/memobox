/**
 * 记忆领域类型 + 共享的打分/图谱工具函数。独立于各 store 实现，
 * 避免相互 import 成环。
 */

export type Memory = {
  id: string;
  content: string;
  kind?: string;
  entities?: string[];
  source?: string;
  createdAt: number;
};

export type QueryLogEntry = {
  id: string;
  query: string;
  recalled: number;
  latencyMs: number | null;
  createdAt: number;
  /** 该查询被标为「相关」的记忆 id（v1.3，未加载时缺省） */
  relevantIds?: string[];
};

export type EntityCount = { name: string; memories: number };

export type EvalStats = {
  totalQueries: number;
  zeroRecall: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
};

export type Label = { memoryId: string; relevant: boolean };

export type Benchmark = {
  labeledQueries: number;
  /** 已标注查询的 recall@k 均值；无有效标注时为 null */
  recall: number | null;
  /** 已标注召回项的 precision 均值；无有效标注时为 null */
  precision: number | null;
};

export interface MemoryStore {
  readonly backend: string;
  readonly retrieval: "semantic" | "keyword";
  save(input: {
    content: string;
    kind?: string;
    entities?: string[];
    source?: string;
  }): Promise<Memory>;
  search(query: string, limit?: number): Promise<Memory[]>;
  list(limit: number): Promise<Memory[]>;
  recentQueries(limit?: number): Promise<QueryLogEntry[]>;
  stats(): Promise<{ total: number; searches: number }>;
  get(id: string): Promise<Memory | null>;
  update(
    id: string,
    patch: { content?: string; kind?: string; entities?: string[] }
  ): Promise<Memory | null>;
  forget(id: string): Promise<boolean>;
  topEntities(limit?: number): Promise<EntityCount[]>;
  evalStats(): Promise<EvalStats>;
  // ---- v1.3 标注式评测 ----
  /** 标注（或改标）某条检索日志里某条记忆的相关性；幂等 upsert */
  label(queryLogId: string, memoryId: string, relevant: boolean): Promise<void>;
  /** 撤销一条标注 */
  unlabel(queryLogId: string, memoryId: string): Promise<void>;
  /** 取一条检索日志 + 它召回的记忆（按当时顺序）+ 现有标注，供标注页渲染 */
  getQuery(
    id: string
  ): Promise<{ entry: QueryLogEntry; recalled: Memory[]; labels: Label[] } | null>;
  /** 还没有任何标注的检索日志（标注队列） */
  unlabeledQueries(limit?: number): Promise<QueryLogEntry[]>;
  /** recall@k / precision 均值（仅统计有标注的查询） */
  benchmark(): Promise<Benchmark>;
  // ---- v1.6 备份/迁移 ----
  /** 全量导出（备份/迁移用）：全部记忆按创建时间升序 */
  exportAll(): Promise<Memory[]>;
  /**
   * 批量导入：保留原 id 与 createdAt（迁移后链接/引用不断），id 已存在则
   * 跳过该条（不覆盖）；向量现算（或无向量落库）。返回导入/跳过计数。
   */
  importMemories(
    items: Memory[]
  ): Promise<{ imported: number; skipped: number }>;
  /**
   * 补算向量（v2.4）：给所有缺 embedding 的记忆现算并落库——
   * `memobox model enable` 之后让存量记忆也能被语义检索命中。
   * 返回补算成功的条数。keyword 模式 / 桩实现直接返回 0。
   */
  backfillEmbeddings(
    onProgress?: (done: number, total: number) => void
  ): Promise<number>;
}

/** 余弦相似度：本地模式（SQLite）的向量检索用 */
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm === 0 ? 0 : dot / norm;
}

/**
 * 查询切词（v2.1）：拉丁部分按空白切、CJK 部分成对切 bigram。
 * 旧实现整句按空白切——中文查询整句成一个 term，子串匹配必落空
 * （「端口有什么偏好」永远匹配不到「…用 3100 端口」）。bigram 后
 * 「端口」「偏好」都是独立 term，`includes` 子串语义直接命中。
 * 单个 CJK 字符的片段原样保留（单字即 term）。
 */
const CJK_RUN = /[㐀-䶿一-鿿]+/g;

export function tokenize(query: string): string[] {
  const terms: string[] = [];
  // 先摘出 CJK 连续段做 bigram，再从剥掉 CJK 的原文里捞拉丁 token
  for (const run of query.toLowerCase().match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      terms.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2));
  }
  const stripped = query.toLowerCase().replace(CJK_RUN, " ");
  for (const t of stripped.split(/[^\p{L}\p{N}_.-]+/u)) {
    if (t) terms.push(t);
  }
  return terms;
}

/**
 * BM25 关键词打分（v2.5，替换 v0.2 的朴素命中计数）：
 * - 词频饱和（k1）：同一个词出现 10 次不会线性加 10 倍分
 * - 文档长度归一（b）：长文档的命中打折，短而准的排前面
 * - 候选集内 IDF：稀有词权重大，常用词（「的」「使用」类 bigram）权重小
 * - 实体命中加成：entities 是人工标注的强信号，额外 ×1.5
 * 零依赖；中文经 tokenize() 的 bigram 天然适配。
 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const ENTITY_BOOST = 1.5;

export function scoreMemories(
  rows: Memory[],
  query: string,
  limit: number
): Memory[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || rows.length === 0) return [];
  const docTokens = rows.map((r) => tokenize(r.content));
  const entityTokens = rows.map((r) =>
    new Set((r.entities ?? []).flatMap((e) => tokenize(e)))
  );
  const entityRaw = rows.map((r) =>
    (r.entities ?? []).map((e) => e.toLowerCase())
  );
  // 候选集内文档频率 → IDF（BM25 变体，恒正）
  const N = rows.length;
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = (t: string) =>
    Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const avgdl = docTokens.reduce((s, d) => s + d.length, 0) / N || 1;
  return rows
    .map((row, i) => {
      const dl = docTokens[i].length;
      let score = 0;
      for (const t of terms) {
        let f = 0;
        for (const x of docTokens[i]) if (x === t) f++;
        if (f > 0) {
          score +=
            (idf(t) * (f * (BM25_K1 + 1))) /
            (f + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl));
        }
        // 实体命中：精确 token 或子串（查询 port 命中实体 ports）
        if (
          entityTokens[i].has(t) ||
          entityRaw[i].some((e) => e.includes(t) || t.includes(e))
        ) {
          score += idf(t) * ENTITY_BOOST;
        }
      }
      return { row, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.row.createdAt - a.row.createdAt)
    .slice(0, limit)
    .map((r) => r.row);
}

/**
 * 图谱扩展（v1.2）：用与直接命中共享实体的记忆补满剩余名额；
 * 直接检索空手而归时，锚点退化为查询词本身（实体即检索入口）。
 * candidates 须已含至少一个锚点实体；按共享实体数排序，其次按时间。
 */
export function expandByEntities(
  candidates: Memory[],
  primary: Memory[],
  anchors: string[],
  limit: number
): Memory[] {
  const slots = limit - primary.length;
  if (slots <= 0 || anchors.length === 0) return [];
  const anchorSet = new Set(anchors.map((a) => a.toLowerCase()));
  const taken = new Set(primary.map((h) => h.id));
  return candidates
    .filter((c) => !taken.has(c.id))
    .map((c) => ({
      c,
      shared: (c.entities ?? []).filter((e) => anchorSet.has(e.toLowerCase()))
        .length,
    }))
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || b.c.createdAt - a.c.createdAt)
    .slice(0, slots)
    .map((x) => x.c);
}

/** 最近邻排名百分位（入参须升序） */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(idx, sortedAsc.length - 1))];
}

/**
 * 标注式基准（v1.3）：
 * recall@k   = |召回 ∩ 相关| / |相关|   —— 相关集含补充标注的漏检记忆
 * precision  = 被标注的召回项中相关的占比
 * 均值只统计有相应标注的查询；无任何有效标注时返回 null。
 */
export function computeBenchmark(
  rows: { recalledIds: string[]; labels: Label[] }[]
): Benchmark {
  let recallSum = 0;
  let recallN = 0;
  let precSum = 0;
  let precN = 0;
  for (const r of rows) {
    if (r.labels.length === 0) continue;
    const recalled = new Set(r.recalledIds);
    const relevant = new Set(
      r.labels.filter((l) => l.relevant).map((l) => l.memoryId)
    );
    if (relevant.size > 0) {
      recallSum +=
        [...relevant].filter((id) => recalled.has(id)).length / relevant.size;
      recallN++;
    }
    const labeledRecalled = r.labels.filter((l) => recalled.has(l.memoryId));
    if (labeledRecalled.length > 0) {
      precSum += labeledRecalled.filter((l) => l.relevant).length / labeledRecalled.length;
      precN++;
    }
  }
  return {
    labeledQueries: recallN + precN > 0 ? rows.filter((r) => r.labels.length > 0).length : 0,
    recall: recallN ? recallSum / recallN : null,
    precision: precN ? precSum / precN : null,
  };
}
