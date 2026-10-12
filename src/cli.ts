#!/usr/bin/env bun
/**
 * memobox CLI（v2.3）—— 给 AI agent 的本地长期记忆，一个命令搞定。
 *
 * 无参数 = stdio MCP 服务（给 Claude Code / Codex / pi 拉起用）；
 * 带子命令 = 人直接操作记忆库。人类输出一律中文（2026-10-11 Soren
 * 要求）；MCP 协议内对 agent 的文案保持英文。
 *
 *   memobox                        # stdio MCP 服务（等价 memobox serve）
 *   memobox save / search / list / forget / entities / stats / path
 *   memobox query / get / sql      # 查询三件套
 *   memobox export / import        # 备份
 *   memobox import-codex           # 迁移 Codex 原生记忆
 *   memobox install claude|codex|pi
 *
 * runCli 把 argv / 输出 / store 全部注入，单测不起真进程；
 * import.meta.main 时才接 process。env：MEMOBOX_DB_PATH 改库文件，
 * EMBEDDING_API_* 启用语义检索（不配 = 关键词模式）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { SQLiteStore } from "@/db/sqlite-store";
import { buildBackup, parseBackup } from "@/lib/backup";
import { runSearchCommand } from "./cli/search";
import { planRestore, readRestoreTarget } from "./lib/restore-preview";
import { parseCodexMemoryMd, parseCodexSummary } from "@/lib/codex-import";
import { defaultDbPath } from "@/lib/paths";
import type { MemoryStore } from "@/lib/memory-store";
import { createEmbedder } from "@/lib/embeddings";
import { defaultConfigPath, loadConfig } from "@/lib/config";
import { detectClaude, detectCodex, detectPi, installClient, serverEntry, type ClientKind } from "@/install";
import { serveStdio } from "@/mcp-server";

import { VERSION } from "./version";
import { parseArgs, parseSince, cmdHelp, USAGE } from "./cli/arguments";
export { VERSION } from "./version";
export { parseArgs, parseSince, cmdHelp, USAGE } from "./cli/arguments";

import { runModelCommand, defaultCliTools, type CliTools } from "./cli/model";
export { defaultCliTools } from "./cli/model";
export type { CliTools } from "./cli/model";

import { renderMemory, renderTable, kindLabel, formatCliError, retrievalLabel, safeEndpoint } from "./cli/presentation";
export { renderMemory, renderTable } from "./cli/presentation";
import { MemoryValidationError, validateMemoryInput } from "./lib/memory-validation";
import { runConfigCommand } from "./cli/config";

/** 注入点：输出流与 store 工厂都可替换（单测用 StubStore + 收集器） */
export type CliIo = {
  out: (s: string) => void;
  err: (s: string) => void;
};

export async function runCli(
  argv: string[],
  io: CliIo,
  makeStore: () => MemoryStore,
  tools: CliTools = defaultCliTools
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs(argv); }
  catch (e) {
    io.err(e instanceof Error ? e.message : "命令参数不正确，请查看 --help");
    return 2;
  }
  try { return await executeCli(parsed, io, makeStore, tools); }
  catch (e) {
    const operation = ({ export: "导出", import: "导入", sql: "SQL 查询", model: "模型操作" } as Record<string, string>)[parsed.pos[0]] ?? "命令执行";
    io.err(formatCliError(e, operation, parsed.flags.has("debug")));
    return e instanceof MemoryValidationError ? 2 : 1;
  }
}

async function executeCli(
  { pos, flags }: ReturnType<typeof parseArgs>,
  io: CliIo,
  makeStore: () => MemoryStore,
  tools: CliTools
): Promise<number> {
  const cmd = pos[0] ?? "serve";

  // 参数解析已拒绝未知命令；帮助在模型和存储操作前返回。
  if (flags.has("help")) {
    io.out(pos.length > 0 ? (cmdHelp(cmd === "model" || cmd === "config" ? pos.join(" ") : cmd) ?? USAGE) : USAGE);
    return 0;
  }

  switch (cmd) {
    case "config":
      return runConfigCommand(pos, flags, io);
    case "serve": {
      await serveStdio(makeStore());
      return 0;
    }
    case "save": {
      const content = pos.slice(1).join(" ");
      if (!content) {
        io.err("用法：memobox save <文本> [--kind ...] [--entities a,b]");
        return 1;
      }
      const row = await makeStore().save({
        content,
        kind: flags.get("kind") as SaveInput["kind"] | undefined,
        entities: flags.get("entities")?.split(",").map((s) => s.trim()).filter(Boolean),
        source: flags.get("source") ?? "cli",
      });
      io.out(`已保存记忆 ${row.id}`);
      return 0;
    }
    case "update": {
      const patch = {
        ...(pos.length > 2 ? { content: pos.slice(2).join(" ") } : {}),
        ...(flags.has("kind") ? { kind: flags.get("kind") } : {}),
        ...(flags.has("source") ? { source: flags.get("source") } : {}),
        ...(flags.has("clear-entities") ? { entities: [] } : flags.has("entities") ? { entities: flags.get("entities")!.split(",").map(s => s.trim()).filter(Boolean) } : {}),
      };
      const memory = await makeStore().update(pos[1], patch);
      if (!memory) { io.err("未找到：" + pos[1]); return 1; }
      io.out(flags.has("json") ? JSON.stringify(memory, null, 2) : "已更新记忆 " + memory.id);
      return 0;
    }
    case "search": {
      const query = pos.slice(1).join(" ");
      if (!query) {
        io.err("用法：memobox search <查询> [--limit 5]");
        return 1;
      }
      return runSearchCommand(query, flags, io, makeStore());
    }
    case "list": {
      const limit = Number(flags.get("limit") ?? 20) || 20;
      const rows = await makeStore().list(limit);
      if (rows.length === 0) io.out("还没有记忆——先用 memobox save <文本> 存一条");
      else rows.forEach((h) => io.out(renderMemory(h)));
      return 0;
    }
    case "forget": {
      const id = pos[1];
      if (!id) {
        io.err("用法：memobox forget <id>");
        return 1;
      }
      const ok = await makeStore().forget(id);
      io[ok ? "out" : "err"](ok ? `已遗忘记忆 ${id}` : `未找到：${id}`);
      return ok ? 0 : 1;
    }
    case "entities": {
      const limit = Number(flags.get("limit") ?? 20) || 20;
      const rows = await makeStore().topEntities(limit);
      if (rows.length === 0) io.out("还没有实体标签");
      else rows.forEach((e) => io.out(`${e.name} (${e.memories})`));
      return 0;
    }
    case "stats": {
      const { total, searches } = await makeStore().stats();
      io.out(`共 ${total} 条记忆，${searches} 次检索 —— 库：${defaultDbPath()}`);
      return 0;
    }
    case "path": {
      io.out(defaultDbPath());
      return 0;
    }
    case "doctor": {
      // 自检：库文件 + 检索模式 + 三家客户端接线，一眼定位「agent 怎么不记事」
      const dbPath = defaultDbPath();
      if (existsSync(dbPath)) {
        const store = makeStore();
        const { total, searches } = await store.stats();
        io.out(`库文件：  ${dbPath}（${total} 条记忆，${searches} 次检索）`);
        io.out(`检索模式：${retrievalLabel(store.retrieval)}`);
        const invalid = (await store.exportAll()).filter(memory => {
          try { validateMemoryInput(memory); return false; } catch { return true; }
        }).length;
        if (invalid) io.err(`发现 ${invalid} 条旧记忆内容或类型不合法。先 export 保留原始备份，再用 get 查看、forget 明确删除后重新保存；不会自动清理。`);
      } else {
        io.out(`库文件：  ${dbPath}（尚未创建——第一次 save 时自动建库）`);
        io.out(`检索模式：${createEmbedder() ? retrievalLabel("semantic") : retrievalLabel("keyword")}`);
      }
      io.out("库路径来源：" + (process.env.MEMOBOX_DB_PATH ? "环境变量 MEMOBOX_DB_PATH" : "默认位置"));
      io.out("配置文件：" + defaultConfigPath() + "（" + (process.env.MEMOBOX_CONFIG_PATH ? "环境变量 MEMOBOX_CONFIG_PATH" : "默认位置") + "）");
      const embedding = loadConfig().embedding;
      io.out("模型配置来源：" + (process.env.EMBEDDING_API_BASE ? "环境变量 EMBEDDING_API_*" : embedding ? "配置文件" : "默认关键词检索"));
      const endpoint = process.env.EMBEDDING_API_BASE || embedding?.base;
      if (endpoint) io.out("嵌入端点：" + safeEndpoint(endpoint));
      io.out("配置优先级：环境变量 > 配置文件 > 默认关键词检索");
      for (const d of [detectCodex(), detectPi(), detectClaude()]) {
        io.out(`${d.client}:     ${d.configured ? "已接线" : "未接线"}  ${d.detail}`);
      }
      // 语义检索没启用时探测本机 Ollama：装了就给一键升级提示（只提示，不自动启用）
      if (!createEmbedder()) {
        const model = await tools.probeOllama();
        if (model) {
          io.out(`提示：    检测到本机 Ollama 服务（推荐模型 ${model}）——一条命令启用本地语义检索：`);
          io.out(`         memobox model enable（自动拉模型、写配置、补算历史向量）`);
        } else if (await tools.ollamaVersion()) {
          io.out(`提示：    本机装了 Ollama 但服务未运行——memobox model enable 会自动拉起`);
        } else {
          io.out(`提示：    轻量语义检索可用内置小模型启用（零外部服务）：memobox model enable --lite`);
        }
      }
      return 0;
    }
    case "model":
      return runModelCommand(pos, flags, io, makeStore, tools);
    case "query": {
      // 结构化过滤（AND 组合）：文本子串 + kind/source 精确 + entity 包含 + 时间下限
      const text = pos.slice(1).join(" ").toLowerCase() || undefined;
      const sinceRaw = flags.get("since");
      const since = sinceRaw !== undefined ? parseSince(sinceRaw) : undefined;
      if (Number.isNaN(since)) {
        io.err(`--since "${sinceRaw}" 格式不对——用 7d / 12h / 30m 或 ISO 日期`);
        return 1;
      }
      const kind = flags.get("kind");
      const source = flags.get("source");
      const entity = flags.get("entity");
      const limit = Number(flags.get("limit") ?? 20) || 20;
      const cut = await makeStore().query({ text, kind, source, entity, since, limit, offset: Number(flags.get("offset") ?? 0) });
      if (flags.has("json")) io.out(JSON.stringify(cut, null, 2));
      else if (cut.length === 0) io.out("(无结果)");
      else
        io.out(
          renderTable(
            cut.map((m) => ({
              编号: m.id,
              创建日期: new Date(m.createdAt).toISOString().slice(0, 10),
              类型: kindLabel(m.kind),
              实体: (m.entities ?? []).join("，"),
              来源: m.source ?? "",
              内容: m.content,
            }))
          )
        );
      return 0;
    }
    case "get": {
      const id = pos[1];
      if (!id) {
        io.err("用法：memobox get <id>");
        return 1;
      }
      const m = await makeStore().get(id);
      if (!m) {
        io.err(`未找到：${id}`);
        return 1;
      }
      io.out(JSON.stringify(m, null, 2));
      return 0;
    }
    case "sql": {
      // 只读 SQL 透传：直接查 SQLite 本体
      const stmt = pos.slice(1).join(" ");
      if (!stmt) {
        io.err('用法：memobox sql "SELECT ..." [--json]');
        return 1;
      }
      if (!/^\s*(select|with|pragma)\b/i.test(stmt)) {
        io.err("只读模式：仅允许 SELECT / WITH / PRAGMA 语句");
        return 1;
      }
      let db: Database;
      try {
        db = new Database(defaultDbPath(), { readonly: true });
      } catch {
        io.err(`打不开 ${defaultDbPath()}——先存一条记忆建库`);
        return 1;
      }
      try {
        const rows = db.query(stmt).all() as Record<string, unknown>[];
        io.out(flags.has("json") ? JSON.stringify(rows, null, 2) : renderTable(rows));
        return 0;
      } catch (e) {
        io.err(formatCliError(e, "SQL 查询", flags.has("debug")));
        return 1;
      } finally {
        db.close();
      }
    }
    case "export": {
      const file = pos[1];
      if (!file) {
        io.err("用法：memobox export <file.json>");
        return 1;
      }
      const backup = buildBackup(await makeStore().exportAll());
      writeFileSync(file, JSON.stringify(backup, null, 2), "utf-8");
      io.out(`已导出 ${backup.memories.length} 条记忆 -> ${file}`);
      return 0;
    }
    case "import": {
      const file = pos[1];
      if (!file) {
        io.err("用法：memobox import <file.json>");
        return 1;
      }
      let parsed;
      try {
        parsed = parseBackup(readFileSync(file, "utf-8"));
      } catch (e) {
        io.err(formatCliError(e, "读取备份", flags.has("debug")));
        return 1;
      }
      if (!parsed.ok) {
        io.err(`导入失败：${parsed.error}`);
        return 1;
      }
      if (flags.has("dry-run")) {
        const preview = planRestore(parsed.items, readRestoreTarget(defaultDbPath()));
        if (flags.has("json")) io.out(JSON.stringify(preview, null, 2));
        else {
          io.out(`恢复预览：共 ${preview.total} 条，新增 ${preview.imported} 条，跳过 ${preview.skipped} 条；未写入记忆`);
          if (preview.duplicateIds.length) io.out("备份内重复编号：" + preview.duplicateIds.join("，"));
          if (preview.conflicts.length) io.out("内容或元数据冲突（保留当前/首条）：" + preview.conflicts.join("，"));
          io.out("预览仅反映当前快照；确认后去掉 --dry-run 执行，已有编号仍不覆盖。");
        }
        return 0;
      }
      const { imported, skipped } = await makeStore().importMemories(parsed.items);
      io.out(flags.has("json") ? JSON.stringify({ imported, skipped }) : `导入完成：新增 ${imported} 条，跳过 ${skipped} 条（已存在）`);
      return 0;
    }
    case "import-codex": {
      // 迁移 Codex 原生记忆：MEMORY.md（任务组）+ memory_summary.md（用户画像）
      const file = flags.get("file") ?? join(homedir(), ".codex", "memories", "MEMORY.md");
      if (!existsSync(file)) {
        io.err(`找不到 ${file}（用 --file 指定 Codex 的 MEMORY.md 路径）`);
        return 1;
      }
      const items = parseCodexMemoryMd(readFileSync(file, "utf-8"));
      const summaryPath = join(dirname(file), "memory_summary.md");
      if (existsSync(summaryPath)) {
        items.push(...parseCodexSummary(readFileSync(summaryPath, "utf-8")));
      }
      if (items.length === 0) {
        io.err("没解析出任何任务——文件格式可能变了，看看 --file 是否指对");
        return 1;
      }
      if (flags.has("dry-run")) {
        io.out(`[试运行] 将导入 ${items.length} 条：`);
        io.out(
          renderTable(
            items.map((m) => ({
              编号: m.id,
              类型: kindLabel(m.kind),
              实体: (m.entities ?? []).join("，"),
              内容: m.content.split("\n")[0],
            }))
          )
        );
        return 0;
      }
      const { imported, skipped } = await makeStore().importMemories(items);
      io.out(`Codex 记忆迁移：解析 ${items.length} 条 → 新增 ${imported}，跳过 ${skipped}（已存在）`);
      return 0;
    }
    case "install": {
      const client = pos[1] as ClientKind | undefined;
      if (client !== "claude" && client !== "codex" && client !== "pi") {
        if (client) {
          io.err("用法：memobox install <claude|codex|pi>");
          return 1;
        }
        // 通用接法：任何 stdio MCP 客户端（Cursor / Windsurf / opencode…）
        // 把同一对 command/args 填进它的 MCP 配置即可。env 只列键名不回显值（KEY 是敏感的）
        const entry = serverEntry();
        io.out("任意 stdio MCP 客户端通用接法（command + args）：");
        io.out(`  command: ${entry.command}`);
        io.out(`  args:    ${entry.args.join(" ")}`);
        if (entry.env) {
          io.out(`  env:     ${Object.keys(entry.env).join(" ")}（值取自当前环境，一并透传）`);
        }
        io.out("内置一键接入：memobox install <claude|codex|pi>");
        return 0;
      }
      const result = await installClient(client);
      io[result.ok ? "out" : "err"](result.message);
      return result.ok ? 0 : 1;
    }
    case "version":
    case "--version":
    case "-v":
      io.out(VERSION);
      return 0;
    case "help":
    case "--help":
    case "-h": {
      const target = pos.slice(1).join(" ");
      if (target) {
        const help = cmdHelp(target);
        if (help) {
          io.out(help);
          return 0;
        }
        io.err(`未知命令：${target}\n\n${USAGE}`);
        return 1;
      }
      io.out(USAGE);
      return 0;
    }
    default:
      io.err(`未知命令：${cmd}\n\n${USAGE}`);
      return 1;
  }
}

type SaveInput = Parameters<MemoryStore["save"]>[0];

// ---- 真进程入口 ----
if (import.meta.main) {
  // store 惰性创建：help/version/install 不该顺手建出 ~/.memobox
  runCli(
    process.argv.slice(2),
    { out: (s) => console.log(s), err: (s) => console.error(s) },
    () => new SQLiteStore(undefined, defaultDbPath())
  )
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(formatCliError(e, "启动", process.argv.includes("--debug")));
      process.exit(1);
    });
}
