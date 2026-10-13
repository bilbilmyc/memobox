import type { MemoryStore } from "../lib/memory";
import { parseSince } from "./arguments";
import { renderMemory } from "./presentation";

export async function runSearchCommand(query: string, flags: Map<string, string>, io: { out(text: string): void }, store: MemoryStore): Promise<number> {
  const limit = Number(flags.get("limit") ?? 5);
  const scope = { kind: flags.get("kind"), entity: flags.get("entity"), source: flags.get("source"), since: flags.has("since") ? parseSince(flags.get("since")!) : undefined };
  if (!flags.has("explain")) {
    const hits = await store.search(query, limit, scope);
    if (flags.has("json")) io.out(JSON.stringify(hits, null, 2));
    else if (!hits.length) io.out("没有匹配的记忆");
    else hits.forEach(h => io.out(renderMemory(h)));
    return 0;
  }
  const report = await store.searchDetailed(query, limit, scope);
  if (flags.has("json")) { io.out(JSON.stringify(report, null, 2)); return 0; }
  const reasons = { embedding_failed: "模型请求失败", zero_vector: "查询向量为零", no_compatible_vectors: "范围内没有兼容向量", below_threshold: "相似度未达到门槛" };
  const { semantic } = report.explanation;
  if (report.queryId) io.out("查询编号：" + report.queryId + "（用 eval show 查看或 eval label 标注）");
  io.out("检索方式：" + (report.explanation.mode === "hybrid" ? "关键词与语义混合" : "关键词"));
  io.out("语义状态：" + (semantic.status === "used" ? "参与排名" : semantic.status === "disabled" ? "未启用" : reasons[semantic.reason!]));
  if (!report.memories.length) io.out("没有匹配的记忆");
  report.memories.forEach((memory, i) => {
    io.out(renderMemory(memory));
    const hit = report.explanation.hits[i], details: string[] = [];
    if (hit.keyword) details.push(`关键词第 ${hit.keyword.rank} 名，分数 ${hit.keyword.score.toFixed(4)}`);
    if (hit.semantic) details.push(`语义第 ${hit.semantic.rank} 名，相似度 ${hit.semantic.score.toFixed(4)}`);
    if (hit.rrfScore !== undefined) details.push(`融合分数 ${hit.rrfScore.toFixed(6)}`);
    if (hit.graph) details.push("实体扩展：" + hit.graph.entities.join("，"));
    io.out("  匹配依据：" + details.join("；"));
  });
  return 0;
}
