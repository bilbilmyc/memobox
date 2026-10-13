/**
 * 记忆领域类型 + 共享的打分/图谱工具函数。独立于各 store 实现，
 * 避免相互 import 成环。
 */

import type { RankedMemory, SearchReport } from "./search-report";
import { rrfContribution } from "./search-report";
import type { MaintenanceInput, MaintenancePlan, MaintenanceScan, MaintenanceSuggestions, MaintenanceOptions, MaintenanceResult, RestoreResult } from "./maintenance";

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
export type QueryReview = {
  entry: QueryLogEntry;
  /** 当时返回的完整编号及顺序；包括后来被遗忘的记忆。 */
  recalledIds: string[];
  /** 当前仍存在的记忆正文，不是历史正文快照。 */
  recalled: Memory[];
  labels: Label[];
};

export type MemoryQuery = {
  text?: string; kind?: string; entity?: string; source?: string;
  since?: number; limit?: number; offset?: number;
};
export type SearchScope = Pick<MemoryQuery, "kind" | "entity" | "source" | "since">;
/** 范围条件按 AND 组合；项目用已有实体标签表达，无需数据库迁移。 */
export function matchesSearchScope(memory: Memory, scope: SearchScope): boolean {
  return (scope.kind === undefined || (memory.kind ?? "fact") === scope.kind) &&
    (scope.source === undefined || memory.source === scope.source) &&
    (scope.since === undefined || memory.createdAt >= scope.since) &&
    (scope.entity === undefined || (memory.entities ?? []).some(e => e.toLowerCase() === scope.entity!.toLowerCase()));
}
export type BackfillReport = {
  inspected: number; needed: number; processed: number;
  succeeded: number; skipped: number; failed: number;
};

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
  search(query: string, limit?: number, scope?: SearchScope): Promise<Memory[]>;
  /** 与普通检索共用快照、排名和日志，额外返回匹配贡献及安全的降级原因。 */
  searchDetailed(query: string, limit?: number, scope?: SearchScope): Promise<SearchReport>;
  scanMaintenance(options?: MaintenanceScan): Promise<MaintenanceSuggestions>;
  planMaintenance(input: MaintenanceInput): Promise<MaintenancePlan>;
  applyMaintenance(plan: MaintenancePlan, options: MaintenanceOptions): Promise<MaintenanceResult>;
  restoreMemories(items: Memory[], options: MaintenanceOptions): Promise<RestoreResult>;
  list(limit: number): Promise<Memory[]>;
  /** 全库参数化过滤，先过滤再分页，创建时间和 id 保证稳定顺序。 */
  query(filters: MemoryQuery): Promise<Memory[]>;
  recentQueries(limit?: number): Promise<QueryLogEntry[]>;
  stats(): Promise<{ total: number; searches: number }>;
  get(id: string): Promise<Memory | null>;
  update(
    id: string,
    patch: { content?: string; kind?: string; entities?: string[]; source?: string }
  ): Promise<Memory | null>;
  forget(id: string): Promise<boolean>;
  topEntities(limit?: number): Promise<EntityCount[]>;
  evalStats(): Promise<EvalStats>;
  // ---- v1.3 标注式评测 ----
  /** 标注（或改标）某条检索日志里某条记忆的相关性；幂等 upsert */
  label(queryLogId: string, memoryId: string, relevant: boolean): Promise<void>;
  /** 撤销一条标注 */
  unlabel(queryLogId: string, memoryId: string): Promise<void>;
  /** 取检索日志、当时召回编号、当前仍存在的记忆与现有标注，供反馈查看。 */
  getQuery(
    id: string
  ): Promise<QueryReview | null>;
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
   * 补算向量：给缺失、损坏或不属于当前模型空间的记忆现算并落库——
   * `memobox model enable` 之后让存量记忆也能被语义检索命中。
   * 报告检查、需要补算、处理、成功、跳过和失败数量，不把失败伪装成无需补算。
   */
  backfillEmbeddings(
    onProgress?: (done: number, total: number) => void
  ): Promise<BackfillReport>;
}

/**
 * 余弦相似度：本地模式（SQLite）的向量检索用。
 * v2.6 起接受 ArrayLike——BLOB 向量解码出的 Float32Array 视图零拷贝直传。
 */
export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new RangeError("embedding dimensions do not match");
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = a.length;
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
 * BM25 关键词打分（v2.5 引入，v2.6 重构为索引）：
 * - 词频饱和（k1）：同一个词出现 10 次不会线性加 10 倍分
 * - 文档长度归一（b）：长文档的命中打折，短而准的排前面
 * - 全库 IDF：稀有词权重大，常用词（「的」「使用」类 bigram）权重小
 * - 实体命中加成：entities 是人工标注的强信号，额外 ×1.5
 * - 整句子串加成（v2.6）：完整查询串在正文出现时额外加分——
 *   查 id / 精确串时不会被 bigram 切碎后的词频稀释
 * 零依赖；中文经 tokenize() 的 bigram 天然适配。
 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const ENTITY_BOOST = 1.5;
const EXACT_BOOST = 5;
const ENGLISH_FUNCTION_WORDS = new Set("a an the and or to of in on for from with is are be was were do does should can what where when how which this that it as at by".split(" "));

/** KeywordIndex 内部的预计算文档 */
type KeywordDoc = {
  m: Memory;
  /** 同分同时间时沿用索引插入顺序，不能由查询词遍历顺序决定。 */
  order: number;
  /** term → 出现次数（查询期 O(1) 查词频，不再线性扫 token 列表） */
  tf: Map<string, number>;
  /** 文档长度（token 数） */
  dl: number;
  /** 小写实体原串（子串匹配用） */
  entityRaw: string[];
  /** 小写全文（整句子串加成用） */
  textLower: string;
};

/**
 * 全库关键词索引（v2.6）：把 tokenize/BM25 的中间产物缓存在进程内，
 * add/remove 增量维护 df 与总长——常驻的 MCP 服务每次 search 只做
 * 查询侧切词 + 打分，不再对全库内容重复 tokenize。
 * IDF/avgdl 基于全库而非候选子集，也砍掉了旧实现「只搜最近 500 条」的上限。
 */
export class KeywordIndex {
  private docs = new Map<string, KeywordDoc>();
  private df = new Map<string, number>();
  private entityDocs = new Map<string, Set<string>>();
  private termDocs = new Map<string, Set<string>>();
  private totalLen = 0;
  private nextOrder = 0;

  rebuild(rows: Memory[]): void {
    this.docs.clear();
    this.df.clear();
    this.entityDocs.clear();
    this.termDocs.clear();
    this.totalLen = 0;
    this.nextOrder = 0;
    for (const m of rows) this.add(m);
  }

  add(m: Memory): void {
    if (this.docs.has(m.id)) this.remove(m.id);
    const tokens = tokenize(m.content);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const doc: KeywordDoc = {
      m,
      order: this.nextOrder++,
      tf,
      dl: tokens.length,
      entityRaw: (m.entities ?? []).map((e) => e.toLowerCase()),
      textLower: m.content.toLowerCase(),
    };
    this.docs.set(m.id, doc);
    // 查询词倒排表按需建立；写入只维护已缓存词，避免冷启动全量扩张。
    for (const [term, ids] of this.termDocs) if (tf.has(term)) ids.add(m.id);
    for (const entity of new Set(doc.entityRaw)) {
      const ids = this.entityDocs.get(entity) ?? new Set<string>();
      ids.add(m.id); this.entityDocs.set(entity, ids);
    }
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.totalLen += doc.dl;
  }

  remove(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    for (const ids of this.termDocs.values()) ids.delete(id);
    for (const t of doc.tf.keys()) {
      const n = (this.df.get(t) ?? 1) - 1;
      if (n <= 0) this.df.delete(t);
      else this.df.set(t, n);
    }
    this.totalLen -= doc.dl;
    for (const entity of new Set(doc.entityRaw)) {
      const ids = this.entityDocs.get(entity)!;
      ids.delete(id); if (!ids.size) this.entityDocs.delete(entity);
    }
    this.docs.delete(id);
  }

  /** 精确实体倒排索引；图谱扩展无需每次读出全库并解析 JSON。 */
  linked(anchors: string[]): Memory[] {
    const ids = new Set<string>();
    for (const entity of anchors) for (const id of this.entityDocs.get(entity.toLowerCase()) ?? []) ids.add(id);
    return [...ids].map(id => this.docs.get(id)!.m);
  }

  search(query: string, limit: number, allow?: (memory: Memory) => boolean): Memory[] {
    return this.match(query, limit, allow, false) as Memory[];
  }

  rank(query: string, limit: number, allow?: (memory: Memory) => boolean): RankedMemory[] {
    return this.match(query, limit, allow, true) as RankedMemory[];
  }

  private match(query: string, limit: number, allow: ((memory: Memory) => boolean) | undefined, explain: boolean): (Memory | RankedMemory)[] {
    const allTerms = [...new Set(tokenize(query))], contentTerms = allTerms.filter(term => !ENGLISH_FUNCTION_WORDS.has(term));
    // 否定词不在停用表中；纯功能词查询仍保留原来的直接检索行为。
    const terms = contentTerms.length ? contentTerms : allTerms;
    const N = this.docs.size;
    const q = query.trim().toLowerCase();
    if (!q || N === 0) return [];
    const exactEligible = q.length >= 2 || terms.length === 0;
    const candidates = new Set<string>();
    let scanAll = false;
    for (const term of terms) {
      if ((this.df.get(term) ?? 0) >= N / 2) { scanAll = true; break; }
      let ids = this.termDocs.get(term);
      if (!ids) {
        ids = new Set();
        for (const doc of this.docs.values()) if (doc.tf.has(term)) ids.add(doc.m.id);
        if (this.termDocs.size >= 128) this.termDocs.delete(this.termDocs.keys().next().value!);
        this.termDocs.set(term, ids);
      }
      for (const id of ids) candidates.add(id);
      if (candidates.size >= N / 2) { scanAll = true; break; }
    }
    // 实体子串和全文精确串仍保留，倒排索引不能漏掉 ports/port 等旧行为。
    if (!scanAll) for (const [entity, ids] of this.entityDocs) {
      if (terms.some(t => entity.includes(t) || t.includes(entity))) for (const id of ids) candidates.add(id);
      if (candidates.size >= N / 2) { scanAll = true; break; }
    }
    if (!scanAll && exactEligible) for (const doc of this.docs.values()) if (doc.textLower.includes(q)) candidates.add(doc.m.id);
    const avgdl = this.totalLen / N || 1;
    // IDF 对同一个查询词是常量，不能在每份文档上重复计算 log。
    const weights = terms.map(term => { const df = this.df.get(term) ?? 0; return { term, idf: Math.log(1 + (N - df + 0.5) / (df + 0.5)) }; });
    const out: { m: Memory; score: number; order: number }[] = [];
    const documents = scanAll ? this.docs.values() : [...candidates].map(id => this.docs.get(id)!);
    for (const doc of documents) {
      if (allow && !allow(doc.m)) continue;
      let score = 0;
      const lengthNorm = BM25_K1 * (1 - BM25_B + (BM25_B * doc.dl) / avgdl);
      for (const weight of weights) {
        const t = weight.term;
        const f = doc.tf.get(t) ?? 0;
        if (f > 0) {
          score +=
            (weight.idf * (f * (BM25_K1 + 1))) /
            (f + lengthNorm);
        }
        // 实体命中：精确 token 或子串（查询 port 命中实体 ports）
        // 实体 token 总是原串的子串，无需每条记忆重复切词/建 Set。
        for (const entity of doc.entityRaw) if (entity.includes(t) || t.includes(entity)) { score += weight.idf * ENTITY_BOOST; break; }
      }
      if (exactEligible && doc.textLower.includes(q)) score += EXACT_BOOST;
      if (score > 0) out.push({ m: doc.m, score, order: doc.order });
    }
    return out
      .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt || a.order - b.order)
      .slice(0, limit)
      .map((x) => explain ? { memory: x.m, score: x.score } : x.m);
  }
}

/**
 * 无状态打分入口（StubStore / 一次性调用用）：
 * 现挖现建索引，保证与常驻索引走完全同一套 BM25 实现（防两套公式漂移）。
 */
export function scoreMemories(
  rows: Memory[],
  query: string,
  limit: number,
  allow?: (memory: Memory) => boolean
): Memory[] {
  const index = new KeywordIndex();
  index.rebuild(rows);
  return index.search(query, limit, allow);
}

/**
 * RRF 混合融合（v2.6）：Reciprocal Rank Fusion——多路排名按名次倒数
 * 求和（1/(k+rank)，k=60 是惯例值），不依赖各路分数量纲可比。
 * 关键词命中的精确匹配与语义命中的近义改写都能进榜，互为补充；
 * 单路为空时自然退化为另一路的排名。
 */
export function rrfFuse(rankings: Memory[][], limit: number): Memory[] {
  const scores = new Map<string, { m: Memory; s: number }>();
  for (const ranking of rankings) {
    ranking.forEach((m, i) => {
      const cur = scores.get(m.id) ?? { m, s: 0 };
      cur.s += rrfContribution(i + 1);
      scores.set(m.id, cur);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.s - a.s || b.m.createdAt - a.m.createdAt)
    .slice(0, limit)
    .map((x) => x.m);
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
