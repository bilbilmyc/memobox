import { copyFileSync, existsSync } from "node:fs";
import type { CliIo } from "../cli";
import { defaultConfigPath, readConfig, saveConfig, parseConfigValue, ConfigValidationError, type MemoboxConfig } from "../lib/config";
import { safeEndpoint, renderTable } from "./presentation";

/** 显示使用白名单，未知扩展字段保留在文件中但不回显。 */
function visible(config: MemoboxConfig): MemoboxConfig {
  if (!config.embedding) return {};
  const e = config.embedding;
  return { embedding: { ...(e.base ? { base: safeEndpoint(e.base) } : {}), ...(e.model !== undefined ? { model: e.model } : {}),
    ...(e.local !== undefined ? { local: e.local } : {}), ...(e.dimensions !== undefined ? { dimensions: e.dimensions } : {}),
    ...(e.timeoutMs !== undefined ? { timeoutMs: e.timeoutMs } : {}),
    ...(e.key !== undefined ? { key: e.key ? "[已隐藏]" : "" } : {}) } };
}

export async function runConfigCommand(pos: string[], flags: Map<string, string>, io: CliIo): Promise<number> {
  const action = pos[1], path = defaultConfigPath(), original = readConfig(path);
  if (action === "reset" && !pos[2]) {
    // 全量重置先保留原文件；坏 JSON 也可以恢复，不先用空对象覆盖它。
    const backup = existsSync(path) ? path + ".backup-" + Date.now() + "-" + crypto.randomUUID() : undefined;
    if (backup) copyFileSync(path, backup);
    saveConfig({}, path);
    io.out("已重置配置" + (backup ? "，原文件备份：" + backup : "") + "；重启 MCP 使模型设置生效，环境变量仍优先");
    return 0;
  }
  if (!original.ok) { io.err(original.error + "；请先修复文件，或 memobox config reset 保留备份后重置"); return 1; }
  const values = visible(original.config), field = pos[2]?.split(".")[1];
  if (action === "show") {
    if (flags.has("json")) io.out(JSON.stringify({ path, priority: "environment > config > keyword", values }, null, 2));
    else {
      io.out("配置文件：" + path + "；优先级：环境变量 > 配置文件 > 默认关键词检索");
      const rows = Object.entries(values.embedding ?? {}).map(([key, value]) => ({ 配置项: "embedding." + key, 值: typeof value === "boolean" ? value ? "已开启" : "已关闭" : value }));
      io.out(rows.length ? renderTable(rows) : "尚未设置文件配置；默认关键词模式，环境变量可覆盖");
    }
    return 0;
  }
  if (action === "get") {
    const value = values.embedding?.[field as keyof typeof values.embedding] ?? null;
    io.out(flags.has("json") ? JSON.stringify({ key: pos[2], value }) : value === null ? "未设置：" + pos[2] : String(value));
    return 0;
  }
  const next = structuredClone(original.config);
  if (action === "set") {
    const value = flags.has("stdin") ? (await Bun.stdin.text()).replace(/[\r\n]+$/, "") : pos[3];
    try {
      const parsed = parseConfigValue(pos[2], value);
      const embedding = { ...next.embedding, [field]: parsed };
      next.embedding = embedding;
      saveConfig(next, path);
    } catch (error) {
      if (!(error instanceof ConfigValidationError)) throw error;
      io.err(error.message); return 2;
    }
    io.out("已写入 " + pos[2] + "；重启 MCP 使模型设置生效，环境变量仍优先");
    return 0;
  }
  const embedding = { ...next.embedding };
  delete embedding[field as keyof typeof embedding];
  if (Object.keys(embedding).length) next.embedding = embedding; else delete next.embedding;
  saveConfig(next, path);
  io.out("已重置 " + pos[2] + "；重启 MCP 使模型设置生效，环境变量仍优先");
  return 0;
}
