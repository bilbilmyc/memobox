import type { Memory } from "./memory";

export type RankedMemory = { memory: Memory; score: number };
export type SemanticStatus = {
  status: "disabled" | "used" | "unavailable" | "no_matches";
  reason?: "embedding_failed" | "zero_vector" | "no_compatible_vectors" | "below_threshold";
};
export type SearchExplanation = {
  mode: "keyword" | "hybrid";
  semantic: SemanticStatus;
  hits: {
    id: string;
    keyword?: { rank: number; score: number };
    semantic?: { rank: number; score: number };
    rrfScore?: number;
    graph?: { entities: string[] };
  }[];
};
export type SearchReport = { memories: Memory[]; explanation: SearchExplanation };
/** RRF 在检索融合与结果解释中共用；排名从 1 开始。 */
export const rrfContribution = (rank: number): number => 1 / (60 + rank);

/** 只解释已经选中的结果；不重新查询、不改变排序、不暴露模型错误详情。 */
export function explainSearch(memories: Memory[], keyword: RankedMemory[], semantic: RankedMemory[], status: SemanticStatus, anchors: string[]): SearchReport {
  const ranks = (rows: RankedMemory[]) => new Map(rows.map((row, i) => [row.memory.id, { rank: i + 1, score: row.score }]));
  const kw = ranks(keyword), sem = ranks(semantic), anchorSet = new Set(anchors.map(e => e.toLowerCase()));
  const hybrid = semantic.length > 0;
  return { memories, explanation: {
    mode: hybrid ? "hybrid" : "keyword", semantic: status,
    hits: memories.map(memory => {
      const k = kw.get(memory.id), s = sem.get(memory.id);
      return { id: memory.id,
        ...(k ? { keyword: k } : {}), ...(s ? { semantic: s } : {}),
        ...(hybrid && (k || s) ? { rrfScore: (k ? rrfContribution(k.rank) : 0) + (s ? rrfContribution(s.rank) : 0) } : {}),
        ...(!k && !s ? { graph: { entities: [...new Set((memory.entities ?? []).filter(e => anchorSet.has(e.toLowerCase())))] } } : {}),
      };
    }),
  } };
}
