import { readFileSync, writeFileSync } from "node:fs";
import type { CliIo } from "../cli";
import type { MemoryStore } from "../lib/memory";
import { maintenanceInputSchema, maintenancePlanSchema } from "../lib/maintenance";
import { parseSince } from "./arguments";

export async function runMaintenanceCommand(pos: string[], flags: Map<string, string>, io: CliIo, makeStore: () => MemoryStore): Promise<number> {
  if (pos[1] === "scan") {
    const suggestions = await makeStore().scanMaintenance({ before: flags.has("before") ? parseSince(flags.get("before")!) : undefined,
      scope: { kind: flags.get("kind"), entity: flags.get("entity"), source: flags.get("source") } });
    if (flags.has("json")) io.out(JSON.stringify(suggestions, null, 2));
    else {
      io.out(`已检查 ${suggestions.inspected} 条：重复组 ${suggestions.duplicates.length}，潜在冲突组 ${suggestions.conflicts.length}，过旧候选 ${suggestions.older.length}；没有改动记忆`);
      suggestions.duplicates.forEach(group => io.out("重复候选（较新在前）：" + group.ids.join("，")));
      suggestions.conflicts.forEach(group => io.out("潜在冲突，需人工判断：" + group.ids.join("，")));
      if (suggestions.older.length) io.out("过旧候选：" + suggestions.older.join("，"));
      io.out("文字相似和年龄不代表事实失效；用 maintain plan 选择编号预览，再 maintain apply --yes 执行。");
    }
    return 0;
  }
  if (pos[1] === "plan") {
    const input = maintenanceInputSchema.safeParse({ ids: flags.get("ids")!.split(",").map(id => id.trim()),
      ...(flags.has("summary-file") ? { replacement: { content: readFileSync(flags.get("summary-file")!, "utf8"), ...(flags.has("kind") ? { kind: flags.get("kind") } : {}) } } : {}) });
    if (!input.success) { io.err("维护参数不合法：编号不能重复或空白，批量最多 1000 条；合并至少两条且摘要不能是空白"); return 2; }
    const plan = await makeStore().planMaintenance(input.data);
    if (flags.has("out")) { writeFileSync(flags.get("out")!, JSON.stringify(plan, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 }); io.out("维护计划已写入 " + flags.get("out") + "；未修改记忆，审核后用 maintain apply <计划.json> --yes"); }
    else io.out(JSON.stringify(plan, null, 2));
    return 0;
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(pos[2], "utf8")); } catch { io.err("无法读取维护计划或不是合法 JSON"); return 1; }
  const parsed = maintenancePlanSchema.safeParse(raw);
  if (!parsed.success) { io.err("维护计划格式不合法，请重新运行 maintain plan"); return 2; }
  try {
    const result = await makeStore().applyMaintenance(parsed.data, { confirm: flags.has("yes") });
    io.out(flags.has("json") ? JSON.stringify(result, null, 2) : `维护完成：删除 ${result.deleted} 条${result.updated ? "，合并保留编号 " + result.updated : ""}；恢复备份：${result.backup}`);
    return 0;
  } catch { io.err("维护未完成：计划可能已过期、备份无法写入或数据库写入失败。记忆不会被部分修改；重新预览并检查备份目录权限。"); return 1; }
}
