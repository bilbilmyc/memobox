import type { MemoryStore } from "../lib/memory";
import { applyFeedback, FeedbackError } from "../lib/feedback";
import { cmdHelp } from "./arguments";
import { renderTable } from "./presentation";

type Io = { out(text: string): void; err(text: string): void };
const percent = (value: number | null) => value === null ? "未标注" : (value * 100).toFixed(1) + "%";

export async function runEvalCommand(pos: string[], flags: Map<string, string>, io: Io, makeStore: () => MemoryStore): Promise<number> {
  const action = pos[1];
  if (!action) { io.out(cmdHelp("eval")!); return 0; }
  const store = makeStore(), json = flags.has("json");
  try {
    if (action === "recent") {
      const limit = Number(flags.get("limit") ?? 20);
      const rows = await (flags.has("unlabeled") ? store.unlabeledQueries(limit) : store.recentQueries(limit));
      io.out(json ? JSON.stringify(rows, null, 2) : !rows.length ? "没有检索记录" : renderTable(
        rows.map(row => ({ 查询编号: row.id, 查询文本: row.query, 召回数: row.recalled, 耗时毫秒: row.latencyMs ?? "未知" }))));
    } else if (action === "show") {
      const review = await store.getQuery(pos[2]);
      if (!review) throw new FeedbackError("query_missing");
      if (json) io.out(JSON.stringify(review, null, 2));
      else {
        io.out(`查询 ${review.entry.id}：${review.entry.query}`);
        const memories = new Map(review.recalled.map(memory => [memory.id, memory]));
        const labels = new Map(review.labels.map(label => [label.memoryId, label.relevant]));
        const ids = [...new Set([...review.recalledIds, ...labels.keys()])];
        io.out(ids.length ? renderTable(ids.map(id => ({ 记忆编号: id,
          当时召回: review.recalledIds.includes(id) ? "是" : "漏召回补标", 标注: labels.has(id) ? labels.get(id) ? "相关" : "不相关" : "未标注",
          当前内容: memories.get(id)?.content ?? (review.recalledIds.includes(id) ? "已不存在" : "用 get 查看") }))) : "当时无召回，也未标注");
        io.out("正文显示当前内容；历史记录只保留召回编号，不保存旧正文。");
      }
    } else if (action === "label" || action === "unlabel") {
      const result = await applyFeedback(store, { queryId: pos[2], memoryId: pos[3], relevant: action === "unlabel" ? null : pos[4] === "relevant" });
      io.out(json ? JSON.stringify(result) : `${action === "unlabel" ? "已撤销标注" : result.relevant ? "已标为相关" : "已标为不相关"}：${result.memoryId}`);
    } else if (action === "report") {
      const stats = await store.evalStats(), benchmark = await store.benchmark();
      const note = "仅统计人工标注样本；召回率分母为已标相关项，精确率分母为已标注的召回项。未标注不算不相关，非完整 Recall@5/Precision@5；标注不自动改变排名。";
      io.out(json ? JSON.stringify({ stats, benchmark, note }, null, 2) : [
        `检索 ${stats.totalQueries} 次，零召回 ${stats.zeroRecall} 次；耗时 P50/P95 ${stats.p50LatencyMs}/${stats.p95LatencyMs} 毫秒`,
        `已标注查询 ${benchmark.labeledQueries} 条；标注召回率 ${percent(benchmark.recall)}，标注精确率 ${percent(benchmark.precision)}`, note,
      ].join("\n"));
    }
    return 0;
  } catch (error) {
    if (!(error instanceof FeedbackError)) throw error;
    io.err({ query_missing: "未找到检索记录，请先用 eval recent 查看编号", memory_missing: "未找到记忆，请核对完整记忆编号", not_recalled: "只能把该次检索实际返回的记忆标为不相关；漏召回记忆可标为相关" }[error.code]);
    return 1;
  }
}
