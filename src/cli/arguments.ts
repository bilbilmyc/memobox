import { parseArgs as parseNodeArgs } from "node:util";
import { VERSION } from "../version";
import { CONFIG_KEYS, parseConfigValue } from "../lib/config";

type Option = { type: "string" | "boolean"; desc: string; value?: string; default?: string; min?: number; max?: number };
type Command = { name: string; args?: string; desc: string; min?: number; max?: number; options?: Record<string, Option>; example?: string };
const flag = (desc: string): Option => ({ type: "boolean", desc });
const str = (desc: string, value: string): Option => ({ type: "string", desc, value });
const limit = (value: number, max = 1000): Option => ({ ...str(`返回条数，范围 1–${max}`, "条数"), default: String(value), min: 1, max });
const kind = str("类型：事实/fact、偏好/preference、事件/event、决策/decision", "类型");
const scopeOptions = { kind, entity: str("按完整实体名称过滤，可用项目标签，不区分大小写", "实体"),
  source: str("按来源精确过滤", "名称"), since: str("创建时间下限：7d/12h/30m 或 ISO 日期", "时间") };
const globals = { help: flag("显示帮助（-h）"), version: flag("显示版本（-v）"), debug: flag("展开已脱敏的技术错误") };
const modelActions: Command[] = [
  { name: "model status", desc: "查看本机模型及检索配置来源", max: 0 },
  { name: "model enable", desc: "启用语义检索，写配置并补算历史向量；重启 MCP 生效", max: 0,
    options: { model: { ...str("Ollama 嵌入模型名称，仅用于端点模式", "名称"), default: "bge-m3" }, lite: flag("使用内置中文小模型（可选依赖，首次下载模型）") },
    example: "memobox model enable --lite\n  memobox model enable --model bge-m3" },
  { name: "model disable", desc: "停用配置文件中的语义检索；环境变量优先，需要单独移除", max: 0 },
  { name: "model reindex", desc: "按当前模型补算缺失/不兼容向量；报告成功、跳过和失败数量", max: 0 },
];
const configActions: Command[] = [
  { name: "config show", desc: "查看文件配置及优先级，密钥和 URL 凭据默认隐藏", max: 0, options: { json: flag("输出 JSON") } },
  { name: "config get", args: "<配置项>", desc: "查看单个配置项，敏感值隐藏", min: 1, max: 1, options: { json: flag("输出 JSON") } },
  { name: "config set", args: "<配置项> [值]", desc: "校验后原子写入；--stdin 从标准输入读取，适合密钥", min: 1, max: 2, options: { stdin: flag("从标准输入读取值，不能同时提供位置值") } },
  { name: "config reset", args: "[配置项]", desc: "重置单项；无配置项时备份原文件并重置全部配置", max: 1 },
];
export const COMMANDS: Command[] = [
  { name: "serve", desc: "启动 stdio MCP 服务（无参数时等价；供 agent 拉起）", max: 0 },
  { name: "save", args: "<文本>", desc: "保存记忆；纯空白内容会被拒绝", min: 1, options: { kind, entities: str("实体标签，用英文逗号分隔", "标签,标签"), source: str("记忆来源名称", "名称") }, example: 'memobox save "开发端口是 3100" --kind 决策 --entities 项目甲' },
  { name: "update", args: "<id> [文本]", desc: "编辑内容或元数据；编号和创建时间保持不变", min: 1, options: {
    kind, entities: str("替换实体标签，用英文逗号分隔", "标签,标签"), "clear-entities": flag("清空实体标签，不能与 --entities 同用"), source: str("替换记忆来源", "名称"), json: flag("输出更新后的完整 JSON") }, example: 'memobox update <id> "开发端口改为 3200" --kind 决策' },
  { name: "search", args: "<查询>", desc: "范围内检索记忆，支持中文整句；语义启用时使用混合检索", min: 1, options: { ...scopeOptions, limit: limit(5, 50), json: flag("输出 JSON；默认数组，--explain 时为包含解释的对象"), explain: flag("显示关键词/语义排名、分数、实体扩展及语义降级原因") } },
  { name: "list", desc: "按创建时间倒序列出记忆", max: 0, options: { limit: limit(20) } },
  { name: "query", args: "[文本]", desc: "全库结构化过滤，条件按 AND 组合；支持分页", options: {
    ...scopeOptions, limit: limit(20),
    offset: { ...str("跳过的条数，用于分页", "条数"), default: "0", min: 0, max: Number.MAX_SAFE_INTEGER }, json: flag("输出稳定字段的 JSON") },
    example: 'memobox query --json "开发端口" --kind 决策 --limit=20 --offset=0' },
  { name: "get", args: "<id>", desc: "查看单条记忆的完整 JSON", min: 1, max: 1 },
  { name: "sql", args: '"SELECT ..."', desc: "只读 SQL 直查 SQLite，不修改记忆", min: 1, options: { json: flag("输出 JSON") } },
  { name: "forget", args: "<id>", desc: "直接删除一条记忆；不支持 --dry-run，未知选项会拒绝执行", min: 1, max: 1 },
  { name: "entities", desc: "统计实体标签和关联记忆数", max: 0, options: { limit: limit(20, 100) } },
  { name: "stats", desc: "显示记忆数和检索数", max: 0 },
  { name: "path", desc: "打印实际库文件位置", max: 0 },
  { name: "doctor", desc: "检查库、检索模式、配置来源和客户端接线", max: 0 },
  { name: "config", args: "<show|get|set|reset>", desc: "管理配置，支持 " + CONFIG_KEYS.join("、"), min: 1, max: 1 },
  { name: "model", args: "<status|enable|disable|reindex>", desc: "管理可选的语义检索；help model enable 查看具体选项", min: 1, max: 1 },
  { name: "export", args: "<文件.json>", desc: "导出全量备份，向量不入备份，可按模型重算", min: 1, max: 1 },
  { name: "import", args: "<文件.json>", desc: "验证并导入备份，相同 id 跳过且不覆盖；可先预览冲突", min: 1, max: 1, options: { "dry-run": flag("只读预览新增/跳过/冲突，不建库、不加载模型"), json: flag("输出导入计数或恢复预览 JSON") } },
  { name: "import-codex", desc: "迁移 Codex 原生记忆，重复导入幂等", max: 0, options: { file: str("MEMORY.md 文件路径", "路径"), "dry-run": flag("仅预览，不写入记忆") } },
  { name: "install", args: "[claude|codex|pi]", desc: "接入 MCP 客户端；无参数打印通用接法", max: 1 },
  { name: "version", desc: "打印版本号", max: 0 },
  { name: "help", args: "[命令] [子命令]", desc: "显示总帮助或指定命令的中文说明", max: 2 },
];

export class CliArgumentError extends Error {}
const kinds: Record<string, string> = { 事实: "fact", 偏好: "preference", 事件: "event", 决策: "decision", fact: "fact", preference: "preference", event: "event", decision: "decision" };
function usage(c: Command): string { return `memobox ${c.name}${c.args ? " " + c.args : ""}`; }
export function cmdHelp(name: string): string | null {
  const c = [...COMMANDS, ...modelActions, ...configActions].find(c => c.name === name);
  if (!c) return null;
  const opts = Object.entries({ ...c.options, ...globals }).map(([name, o]) =>
    `  --${name}${o.value ? " <" + o.value + ">" : ""}  ${o.desc}${o.default !== undefined ? "（默认 " + o.default + "）" : ""}`);
  return `${usage(c)}\n  ${c.desc}\n\n选项：\n${opts.join("\n")}${c.example ? "\n\n示例：\n  " + c.example : ""}`;
}
export const USAGE = `memobox ${VERSION} —— 给 AI agent 的本地长期记忆（SQLite，零服务）\n\n用法：memobox <命令> [参数]\n\n命令：\n` +
  COMMANDS.map(c => `  ${usage(c)}\n      ${c.desc}`).join("\n") +
  "\n\n全局选项：--help/-h、--version/-v、--debug\n" +
  "选项支持 --名称 值、--名称=值；-- 后的内容作为文本。\n退出码：0 成功；1 执行失败；2 参数错误。\n\n环境变量：\n" +
  "  MEMOBOX_DB_PATH      库文件位置（默认 ~/.memobox/memobox.db）\n" +
  "  MEMOBOX_CONFIG_PATH  配置文件位置（默认 ~/.memobox/config.json）\n" +
  "  EMBEDDING_API_BASE   OpenAI 兼容嵌入端点，启用混合检索\n" +
  "  EMBEDDING_API_KEY    可选密钥，本地端点通常不需要\n" +
  "  EMBEDDING_MODEL      嵌入模型名称\n" +
  "  EMBEDDING_DIM        嵌入向量维度（正整数）\n" +
  "  EMBEDDING_TIMEOUT_MS 嵌入请求超时（毫秒，默认 5000）\n" +
  "  HF_ENDPOINT          内置模型的优先下载源\n" +
  "配置优先级：环境变量 > 配置文件 > 默认关键词检索。\n运行环境：Bun ≥ 1.4（本版本 npm 包仍需要 Bun）。\n详细选项与中文示例：memobox help <命令>。";

/** 参数类型、作用范围和帮助共用规格；所有检查先于存储和模型副作用。 */
export function parseArgs(argv: string[]): { pos: string[]; flags: Map<string, string> } {
  const options: Record<string, { type: "string" | "boolean"; short?: string }> = {};
  for (const c of [...COMMANDS, ...modelActions, ...configActions]) for (const [name, o] of Object.entries(c.options ?? {})) options[name] = { type: o.type };
  for (const [name, o] of Object.entries(globals)) options[name] = { type: o.type, ...(name === "help" ? { short: "h" } : name === "version" ? { short: "v" } : {}) };
  let parsed: ReturnType<typeof parseNodeArgs>;
  try { parsed = parseNodeArgs({ args: argv, options, allowPositionals: true, strict: true }); }
  catch (e) {
    const message = e instanceof Error ? e.message : "";
    const option = message.match(/(?:option|Option) ['"]([^'"]+)['"]/i)?.[1]?.split("=")[0] ?? "命令选项";
    throw new CliArgumentError(`${option} 不受支持、缺少值或类型不对；请查看 --help`);
  }
  const pos = parsed.positionals as string[];
  if (parsed.values.version) return { pos: ["version"], flags: new Map() };
  const command = pos[0] ?? "serve";
  const c = COMMANDS.find(c => c.name === command);
  if (!c) throw new CliArgumentError(`未知命令：${command}\n${USAGE}`);
  const sub = command === "model" && pos[1] ? modelActions.find(c => c.name === `model ${pos[1]}`) : command === "config" && pos[1] ? configActions.find(c => c.name === `config ${pos[1]}`) : undefined;
  if (command === "model" && pos[1] && !sub) throw new CliArgumentError(`未知模型命令：${pos[1]}；用法：memobox model <status|enable|disable|reindex>`);
  if (command === "config" && pos[1] && !sub) throw new CliArgumentError("未知配置命令；用法：memobox config <show|get|set|reset>");
  const effective = sub ?? c, allowed = { ...effective.options, ...globals };
  const flags = new Map<string, string>();
  for (const [name, value] of Object.entries(parsed.values)) {
    if (!(name in allowed)) throw new CliArgumentError(`${effective.name} 不支持 --${name}；请查看该命令的 --help`);
    if (value !== undefined) flags.set(name, value === true ? "" : String(value));
  }
  if (flags.has("help")) return { pos, flags };
  if (command === "help") {
    if (pos.length > 3 || (pos[1] && !cmdHelp(pos.slice(1).join(" ")))) throw new CliArgumentError(`未知命令：${pos.slice(1).join(" ")}`);
    return { pos, flags };
  }
  const count = pos.length - (sub ? 2 : pos.length ? 1 : 0);
  if (count < (effective.min ?? 0) || (effective.max !== undefined && count > effective.max)) throw new CliArgumentError(`用法：${usage(effective)}`);
  for (const [name, o] of Object.entries(effective.options ?? {})) {
    if (!flags.has(name) && o.default !== undefined) flags.set(name, o.default);
    if (o.type === "string" && flags.has(name)) {
      const value = flags.get(name)!;
      if (!value.trim()) throw new CliArgumentError(`--${name} 的值不能为空`);
      if (o.min !== undefined && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < o.min || Number(value) > o.max!)) throw new CliArgumentError(`--${name} 必须是 ${o.min}–${o.max} 范围内的整数`);
    }
  }
  if (flags.has("kind")) {
    const value = flags.get("kind")!;
    const normalized = Object.hasOwn(kinds, value) ? kinds[value] : undefined;
    if (!normalized) throw new CliArgumentError("--kind 必须是事实/fact、偏好/preference、事件/event 或决策/decision");
    flags.set("kind", normalized);
  }
  if (command === "config") {
    if (pos[2] && !(CONFIG_KEYS as readonly string[]).includes(pos[2])) throw new CliArgumentError("未知配置项，可选：" + CONFIG_KEYS.join("、"));
    if (pos[1] === "set") {
      if (flags.has("stdin") === (pos.length > 3)) throw new CliArgumentError("提供一个配置值，或使用 --stdin 读取，不能同时使用");
      if (!flags.has("stdin")) try { parseConfigValue(pos[2], pos[3]); } catch (error) { throw new CliArgumentError(error instanceof Error ? error.message : "配置值不正确"); }
    }
  }
  if (command === "save" && !pos.slice(1).join(" ").trim()) throw new CliArgumentError("记忆内容不能是纯空白文本");
  if (command === "update") {
    if (!pos[1]?.trim()) throw new CliArgumentError("记忆编号不能为空");
    if (pos.length > 2 && !pos.slice(2).join(" ").trim()) throw new CliArgumentError("记忆内容不能是纯空白文本");
    if (flags.has("entities") && flags.has("clear-entities")) throw new CliArgumentError("--entities 与 --clear-entities 不能同时使用");
    if (pos.length < 3 && !["kind", "entities", "clear-entities", "source"].some(name => flags.has(name))) throw new CliArgumentError("至少提供要更新的文本、类型、实体或来源");
  }
  if (command === "search" && !pos.slice(1).join(" ").trim()) throw new CliArgumentError("查询文本不能为空");
  if (command === "install" && pos[1] && !["claude", "codex", "pi"].includes(pos[1])) throw new CliArgumentError("用法：memobox install <claude|codex|pi>");
  if (sub?.name === "model enable" && flags.has("lite") && Object.hasOwn(parsed.values, "model")) throw new CliArgumentError("--lite 使用内置模型，不能同时指定 --model");
  if (flags.has("since") && !Number.isFinite(parseSince(flags.get("since")!))) throw new CliArgumentError("--since 格式不对——用 7d / 12h / 30m 或 ISO 日期");
  return { pos, flags };
}

export function parseSince(value: string): number {
  const rel = /^(\d+)([dhm])$/.exec(value);
  if (rel) return Date.now() - Number(rel[1]) * ({ d: 864e5, h: 36e5, m: 6e4 }[rel[2]]!);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return NaN;
  const day = Date.parse(value.slice(0, 10));
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
  return Date.parse(value);
}
