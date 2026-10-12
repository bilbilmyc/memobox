import type { Memory } from "../lib/memory";
import { safeEndpoint, redactDetails } from "../lib/diagnostics";
export { safeEndpoint, redactDetails } from "../lib/diagnostics";
import { MemoryValidationError, memoryValidationMessage } from "../lib/memory-validation";

export function kindLabel(kind?: string): string {
  return ({ fact: "事实", preference: "偏好", event: "事件", decision: "决策" } as Record<string, string>)[kind ?? "fact"] ?? `未知类型（${kind}）`;
}
export const retrievalLabel = (mode: string) => mode === "semantic" ? "混合检索（关键词 + 语义）" : "关键词检索";
export function renderMemory(m: Memory): string {
  return `[${m.id}] ${m.content}${m.entities?.length ? `（实体：${m.entities.join("，")}）` : ""}`;
}

const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
function cell(value: unknown): string {
  const text = value === null || value === undefined ? "（空）" : String(value).replace(/[\r\n]+/g, " ↵ ").replaceAll("\t", "  ");
  if (Bun.stringWidth(text) <= 48) return text;
  let result = "", width = 0;
  for (const { segment } of segmenter.segment(text)) {
    const next = Bun.stringWidth(segment);
    if (width + next > 47) break;
    result += segment; width += next;
  }
  return result + "…";
}
/** 宽度使用终端显示列数；截断按字素簇，不切开中文、emoji 或组合字符。 */
export function renderTable(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "(无结果)";
  const keys = Object.keys(rows[0]), body = rows.map(row => keys.map(key => cell(row[key])));
  const widths = keys.map((key, i) => Math.max(Bun.stringWidth(key), ...body.map(row => Bun.stringWidth(row[i]))));
  const line = (cells: string[]) => cells.map((text, i) => text + " ".repeat(widths[i] - Bun.stringWidth(text))).join("  ").trimEnd();
  return [line(keys), ...body.map(line)].join("\n");
}

export function formatCliError(error: unknown, operation = "命令执行", debug = false): string {
  const technical = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  let reason = error instanceof MemoryValidationError ? memoryValidationMessage(error) : "操作未完成，请检查文件路径、权限或模型配置";
  if (code === "ENOENT") reason = "文件或上级目录不存在，请检查路径";
  else if (code === "EACCES" || code === "EPERM") reason = "没有文件访问权限，请检查目录权限或文件占用";
  else if (code === "EISDIR") reason = "需要文件路径，实际指定的是目录";
  else if (/syntax error/i.test(technical)) reason = "SQL 语法不正确，请检查语句";
  else if (/no such table|no such column/i.test(technical)) reason = "SQL 引用了不存在的表或列";
  else if (/database is locked/i.test(technical)) reason = "数据库暂时被占用，请稍后重试";
  return `${operation}失败：${reason}${debug ? "\n技术详情：" + redactDetails(technical) : ""}`;
}
