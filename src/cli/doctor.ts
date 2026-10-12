import { homedir } from "node:os";
import { localRuntimeEntry } from "../lib/optional-runtime";
import type { CliIo } from "../cli";
import type { CliTools } from "./model";
import { defaultDbPath } from "../lib/paths";
import { createEmbedder } from "../lib/embeddings";
import { defaultConfigPath, readConfig } from "../lib/config";
import { inspectDatabase } from "../lib/database-diagnostics";
import { inspectClients } from "../lib/client-diagnostics";
import { safeEndpoint, retrievalLabel } from "./presentation";

export async function runDoctorCommand(flags: Map<string, string>, io: CliIo, tools: CliTools): Promise<number> {
  const dbPath = defaultDbPath(), configPath = defaultConfigPath(), config = readConfig();
  let provider = null, modelError = false;
  try { provider = createEmbedder(); } catch { modelError = true; }
  const database = inspectDatabase(dbPath, provider), home = tools.clientHome ?? homedir();
  const clients = inspectClients(home, dbPath, configPath);
  const local = config.ok && config.config.embedding?.local && !process.env.EMBEDDING_API_BASE;
  let dependency = "not_required";
  if (local) dependency = localRuntimeEntry() ? "installed" : "missing";
  const endpoint = process.env.EMBEDDING_API_BASE || (config.ok ? config.config.embedding?.base : undefined);
  const source = process.env.EMBEDDING_API_BASE ? "environment" : config.ok && config.config.embedding ? "config" : "keyword";
  const report = { dbPath, configPath, database, clients, model: { mode: provider ? local ? "local" : "endpoint" : "keyword", source,
    ...(endpoint ? { endpoint: safeEndpoint(endpoint) } : {}), ...(provider ? { dimensions: provider.dimensions, minimumSimilarity: provider.minimumSimilarity ?? 0.35 } : {}), dependency, valid: !modelError && config.ok } };
  const vectors = database.vectors;
  const unhealthy = database.integrity === "error" || database.foreignKeyErrors > 0 || database.invalidMemories > 0 || modelError || !config.ok || dependency === "missing" ||
    clients.some(client => client.error || client.configured && (client.commandExists === false || client.explicitDb && client.dbMatches === false || client.explicitConfig && client.configMatches === false)) ||
    Boolean(provider && (vectors.missing + vectors.invalid + vectors.incompatible + vectors.dimensionMismatch + vectors.unknownSpace));
  if (flags.has("json")) { io.out(JSON.stringify(report, null, 2)); return flags.has("strict") && unhealthy || database.integrity === "error" ? 1 : 0; }
  io.out(`库文件：  ${dbPath}（${database.exists ? `${database.total} 条记忆，${database.searches} 次检索` : "尚未创建——第一次 save 时自动建库"}）`);
  io.out("检索模式：" + retrievalLabel(provider ? "semantic" : "keyword"));
  io.out("库完整性：" + (database.integrity === "ok" ? "通过" : database.integrity === "not_created" ? "尚未创建" : "异常，先备份原文件后检查，诊断没有修改数据库"));
  io.out(`向量：有效 ${vectors.valid}，缺失 ${vectors.missing}，损坏/零向量 ${vectors.invalid}，未知来源 ${vectors.unknownSpace}，模型空间不匹配 ${vectors.incompatible}，配置维度不匹配 ${vectors.dimensionMismatch}`);
  if (provider && vectors.missing + vectors.invalid + vectors.unknownSpace + vectors.incompatible + vectors.dimensionMismatch) io.out("修复提示：核对 embedding.dimensions 和模型后运行 memobox model reindex；重启 MCP 使配置生效。");
  if (database.invalidMemories) io.err(`发现 ${database.invalidMemories} 条旧记忆内容或类型不合法。先 export 保留原始备份，再用 get 查看、update 修订或 forget 明确删除；不会自动清理。`);
  io.out("库路径来源：" + (process.env.MEMOBOX_DB_PATH ? "环境变量 MEMOBOX_DB_PATH" : "默认位置"));
  io.out("配置文件：" + configPath + "（" + (process.env.MEMOBOX_CONFIG_PATH ? "环境变量 MEMOBOX_CONFIG_PATH" : "默认位置") + "）");
  io.out("模型配置来源：" + (source === "environment" ? "环境变量 EMBEDDING_API_*" : source === "config" ? "配置文件" : "默认关键词检索"));
  if (endpoint) io.out("嵌入端点：" + safeEndpoint(endpoint));
  io.out("配置优先级：环境变量 > 配置文件 > 默认关键词检索");
  if (!config.ok || modelError) io.err("模型配置不合法；运行 memobox config show 检查，config reset 会先保留备份。");
  if (dependency === "missing") io.err("内置模型依赖缺失，运行 memobox model enable --lite 安装并验证。");
  for (const client of clients) io.out(`${client.client}:     ${client.configured ? "已接线" : "未接线"}  ${client.path}` +
    (client.error ? "（配置无效，请检查或重新 install）" : client.configured ? `（库${client.explicitDb ? client.dbMatches ? "一致" : "不一致" : "默认推断"}，配置${client.explicitConfig ? client.configMatches ? "一致" : "不一致" : "默认推断"}${client.commandExists === false ? "，启动命令不存在" : ""}）` : ` —— memobox install ${client.client}`));
  if (clients.some(client => client.configured && (!client.explicitDb || !client.explicitConfig))) io.out("默认推断采用用户目录；客户端启动时可能继承其他环境变量，请核对实际进程。重新 install 会固化当前接线路径。");
  if (!provider && !modelError) {
    const model = await tools.probeOllama();
    if (model) io.out(`提示：检测到本机 Ollama 服务（推荐模型 ${model}）——memobox model enable 自动拉模型、写配置、补算历史向量`);
    else if (await tools.ollamaVersion()) io.out("提示：本机装了 Ollama 但服务未运行——memobox model enable 会自动拉起");
    else io.out("提示：内置小模型可选：memobox model enable --lite");
  }
  return flags.has("strict") && unhealthy || database.integrity === "error" ? 1 : 0;
}
