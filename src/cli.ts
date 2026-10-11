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
import { parseCodexMemoryMd, parseCodexSummary } from "@/lib/codex-import";
import { defaultDbPath } from "@/lib/paths";
import type { Memory, MemoryStore } from "@/lib/memory-store";
import { createEmbedder, probeOllama } from "@/lib/embeddings";
import { createLocalEmbedder, LOCAL_EMBED_MODEL } from "@/lib/local-embedder";
import { defaultConfigPath, loadConfig, saveConfig } from "@/lib/config";
import {
  DEFAULT_EMBED_MODEL,
  OLLAMA_HOST,
  ensureOllamaServer,
  formatPullStatus,
  ollamaModels,
  ollamaVersion,
  pullOllamaModel,
  type PullStatus,
} from "@/lib/ollama";
import { detectClaude, detectCodex, detectPi, installClient, serverEntry, type ClientKind } from "@/install";
import { serveStdio } from "@/mcp-server";

export const VERSION = "2.5.0";

/** doctor / model 子命令的外部依赖（真入口用默认值；单测注入假实现不碰网络） */
export type CliTools = {
  probeOllama: () => Promise<string | null>;
  ollamaVersion: () => Promise<string | null>;
  ensureServer: () => Promise<boolean>;
  listModels: () => Promise<string[] | null>;
  pull: (name: string, onStatus: (s: PullStatus) => void) => Promise<boolean>;
  /** 内置小模型预检：加载模型并 embed 一条自检文本（enable --lite 用） */
  loadLocalModel: (onProgress?: (msg: string) => void) => Promise<void>;
};

export const defaultCliTools: CliTools = {
  probeOllama,
  ollamaVersion,
  ensureServer: () => ensureOllamaServer(),
  listModels: () => ollamaModels(),
  pull: (name, onStatus) => pullOllamaModel(name, onStatus),
  loadLocalModel: async (onProgress) => {
    await createLocalEmbedder(onProgress).embed("memobox 启动自检");
  },
};

/** 子命令规格表：--help / help <命令> / 总帮助都从这里渲染 */
type CmdSpec = { name: string; usage: string; desc: string };

const COMMANDS: CmdSpec[] = [
  { name: "serve", usage: "memobox serve", desc: "启动 stdio MCP 服务（无参数时等价；供 Claude Code / Codex / pi 拉起）" },
  { name: "save", usage: "memobox save <文本> [--kind fact|preference|event|decision] [--entities a,b] [--source 名字]", desc: "存一条记忆" },
  { name: "search", usage: "memobox search <查询> [--limit 5]", desc: "检索记忆（关键词/语义自动，支持中文整句）" },
  { name: "list", usage: "memobox list [--limit 20]", desc: "按时间倒序列出记忆" },
  { name: "query", usage: "memobox query [文本] [--kind k] [--entity e] [--source s] [--since 7d|12h|30m|ISO日期] [--limit 20] [--json]", desc: "结构化过滤查询（条件 AND 组合）" },
  { name: "get", usage: "memobox get <id>", desc: "查看单条记忆（完整 JSON）" },
  { name: "sql", usage: 'memobox sql "SELECT ..." [--json]', desc: "只读 SQL 直查 SQLite 库文件" },
  { name: "forget", usage: "memobox forget <id>", desc: "删除一条记忆（实体边级联清理）" },
  { name: "entities", usage: "memobox entities [--limit 20]", desc: "实体标签统计（记忆图谱入口）" },
  { name: "stats", usage: "memobox stats", desc: "库统计（记忆数 / 检索数）" },
  { name: "path", usage: "memobox path", desc: "打印库文件位置" },
  { name: "doctor", usage: "memobox doctor", desc: "自检：库文件 / 检索模式 / 三家客户端接线状态" },
  { name: "model", usage: "memobox model <status|enable|disable> [--model bge-m3] [--lite]", desc: "语义检索管理：enable 用 Ollama（能力强）；enable --lite 用内置小模型（约 25MB 进程内推理，零外部依赖）" },
  { name: "export", usage: "memobox export <file.json>", desc: "全量备份（memobox-backup v1 格式，向量不入备份可重算）" },
  { name: "import", usage: "memobox import <file.json>", desc: "导入备份（幂等：相同 id 跳过）" },
  { name: "import-codex", usage: "memobox import-codex [--file <MEMORY.md路径>] [--dry-run]", desc: "迁移 Codex 原生记忆（~/.codex/memories/，任务+用户画像；重复导入幂等）" },
  { name: "install", usage: "memobox install [claude|codex|pi]", desc: "接入 MCP 客户端（无参数打印任意客户端的通用接法；幂等，自动透传 EMBEDDING_API_*）" },
  { name: "version", usage: "memobox version", desc: "打印版本号" },
  { name: "help", usage: "memobox help [命令]", desc: "总帮助，或某条命令的详细用法" },
];

/** 总帮助 */
export const USAGE =
  `memobox ${VERSION} —— 给 AI agent 的本地长期记忆（SQLite，零服务）\n\n` +
  `用法：memobox <命令> [参数]\n\n` +
  `命令：\n` +
  COMMANDS.map((c) => `  ${c.usage}\n      ${c.desc}`).join("\n") +
  `\n\n环境变量：\n` +
  `  MEMOBOX_DB_PATH    库文件位置（默认 ~/.memobox/memobox.db）\n` +
  `  EMBEDDING_API_*    OpenAI 兼容 /embeddings 端点，配了走语义检索\n` +
  `                     （不配 = 关键词模式，中文已支持；本地端点免 KEY）`;

/** 单条命令的帮助；未知命令返回 null */
export function cmdHelp(name: string): string | null {
  const c = COMMANDS.find((x) => x.name === name);
  return c ? `${c.usage}\n      ${c.desc}` : null;
}

/** 极简参数解析：位置参数按序收集，--flag 值成对收集（末尾孤旗标=布尔） */
export function parseArgs(argv: string[]): {
  pos: string[];
  flags: Map<string, string>;
} {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags.set(argv[i].slice(2), argv[++i]);
    } else if (argv[i].startsWith("--")) {
      flags.set(argv[i].slice(2), ""); // 布尔旗标（--json / --help / --dry-run）
    } else {
      pos.push(argv[i]);
    }
  }
  return { pos, flags };
}

/** 一条记忆的展示行：`[id] content (entities: ...)`——与 MCP 输出同款 */
export function renderMemory(m: Memory): string {
  return `[${m.id}] ${m.content}${m.entities?.length ? ` (entities: ${m.entities.join(", ")})` : ""}`;
}

/** 终端表格：列对齐，超宽单元格截断（完整内容走 --json 或 get） */
export function renderTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(无结果)";
  const keys = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "NULL" : String(v);
    return s.length > 48 ? s.slice(0, 47) + "…" : s;
  };
  const body = rows.map((r) => keys.map((k) => cell(r[k])));
  const widths = keys.map((k, i) =>
    Math.max(k.length, ...body.map((r) => r[i].length))
  );
  const line = (cs: string[]) =>
    cs.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(keys), ...body.map(line)].join("\n");
}

/**
 * --since 解析：`7d` / `12h` / `30m` 相对时长，或 ISO 日期/日期时间。
 * 返回毫秒时间戳下限；格式不合法返回 NaN。
 */
export function parseSince(v: string): number {
  const rel = /^(\d+)([dhm])$/.exec(v);
  if (rel) {
    const unit = rel[2] === "d" ? 864e5 : rel[2] === "h" ? 36e5 : 6e4;
    return Date.now() - Number(rel[1]) * unit;
  }
  return Date.parse(v);
}

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
  const { pos, flags } = parseArgs(argv);
  const cmd = pos[0] ?? "serve";

  // 任意命令后跟 --help：打印该命令的帮助；裸 --help / 未知命令回落到总帮助
  if (flags.has("help")) {
    io.out(pos.length > 0 ? (cmdHelp(cmd) ?? USAGE) : USAGE);
    return 0;
  }

  switch (cmd) {
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
    case "search": {
      const query = pos.slice(1).join(" ");
      if (!query) {
        io.err("用法：memobox search <查询> [--limit 5]");
        return 1;
      }
      const limit = Number(flags.get("limit") ?? 5) || 5;
      const hits = await makeStore().search(query, limit);
      if (hits.length === 0) io.out("没有匹配的记忆");
      else hits.forEach((h) => io.out(renderMemory(h)));
      return 0;
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
        io.out(`检索模式：${store.retrieval === "keyword" ? "keyword（memobox model enable 可启用语义检索）" : store.retrieval}`);
      } else {
        io.out(`库文件：  ${dbPath}（尚未创建——第一次 save 时自动建库）`);
        io.out(`检索模式：${createEmbedder() ? "semantic" : "keyword（memobox model enable 可启用语义检索）"}`);
      }
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
          io.out(`提示：    轻量语义检索可用内置小模型启用（零外部依赖）：memobox model enable --lite`);
        }
      }
      return 0;
    }
    case "model": {
      // 本地嵌入模型管理（v2.4，CherryStudio 式）：
      // enable = 检测 Ollama → 没跑就拉起 serve → 缺模型就流式拉取 → 写配置 → 补算存量向量
      const sub = pos[1];
      if (sub === "status") {
        const ver = await tools.ollamaVersion();
        io.out(`本机 Ollama：${ver ? `已安装（${ver}）` : "未安装（https://ollama.com 下载）"}`);
        const models = ver ? await tools.listModels() : null;
        io.out(`Ollama 服务：${models ? `运行中（${models.length} 个模型${models.length ? "：" + models.join(", ") : ""}）` : "未运行"}`);
        const fromEnv = Boolean(process.env.EMBEDDING_API_BASE);
        const cfg = loadConfig().embedding;
        const mode = fromEnv
          ? "semantic（来源：环境变量 EMBEDDING_API_*）"
          : cfg?.base
            ? `semantic（来源：${defaultConfigPath()}，端点 ${cfg.base}）`
            : cfg?.local
              ? `semantic（来源：内置模型 ${cfg.model ?? LOCAL_EMBED_MODEL}，进程内推理）`
              : "keyword（memobox model enable --lite 可最轻启用语义检索）";
        io.out(`检索模式：  ${mode}`);
        return 0;
      }
      if (sub === "enable") {
        // --lite：内置小模型（v2.5 轻量方案）——不碰 Ollama，进程内推理
        if (flags.has("lite")) {
          io.out(`启用内置嵌入模型 ${LOCAL_EMBED_MODEL}（约 25MB，缓存在 ~/.memobox/models）…`);
          try {
            await tools.loadLocalModel((m) => io.out(`  ${m}`));
          } catch (e) {
            io.err(`内置模型加载失败：${e instanceof Error ? e.message : e}`);
            io.err("检查网络后重试（默认源 hf-mirror.com；可用环境变量 HF_ENDPOINT 换源）");
            return 1;
          }
          saveConfig({ ...loadConfig(), embedding: { local: true, model: LOCAL_EMBED_MODEL } });
          const backfilled = await makeStore().backfillEmbeddings((done, total) => {
            if (done % 10 === 0 || done === total) io.out(`  补算向量 ${done}/${total}`);
          });
          if (backfilled > 0) io.out(`已补算 ${backfilled} 条历史记忆的向量`);
          io.out(`✓ 语义检索已启用（内置模型，零外部服务）——写入 ${defaultConfigPath()}`);
          io.out(`  所有 memobox 进程（含 MCP 服务）下次启动自动生效，无需重装客户端`);
          return 0;
        }
        const model = flags.get("model") ?? DEFAULT_EMBED_MODEL;
        const ver = await tools.ollamaVersion();
        if (!ver) {
          io.err("未检测到 Ollama——先去 https://ollama.com 下载安装；或改用云端端点（.env.example 有示例）");
          return 1;
        }
        io.out(`Ollama 已安装（${ver}）`);
        if (!(await tools.ensureServer())) {
          io.err("Ollama 服务拉不起来——手动跑 `ollama serve` 后重试");
          return 1;
        }
        const models = await tools.listModels();
        if (models && !models.includes(model)) {
          io.out(`拉取模型 ${model}（首次约 1.2GB，取决于网速）…`);
          // 进度节流：状态词变化必打；纯下载进度每 +10% 打一行
          let lastStatus = "";
          let lastPct = -100;
          const ok = await tools.pull(model, (s) => {
            const pct = s.total ? Math.floor(((s.completed ?? 0) / s.total) * 100) : null;
            if (s.status !== lastStatus || (pct !== null && pct - lastPct >= 10)) {
              io.out(`  ${formatPullStatus(s)}`);
              lastStatus = s.status;
              if (pct !== null) lastPct = pct;
            }
          });
          if (!ok) {
            io.err("模型拉取失败（网络中断？）——重试 memobox model enable 会续传");
            return 1;
          }
        } else {
          io.out(`模型 ${model} 已就绪`);
        }
        // 先写配置再造 store——store 构造时读配置才能拿到刚启用的 embedder
        saveConfig({ ...loadConfig(), embedding: { base: `${OLLAMA_HOST}/v1`, model } });
        const backfilled = await makeStore().backfillEmbeddings((done, total) => {
          if (done % 10 === 0 || done === total) io.out(`  补算向量 ${done}/${total}`);
        });
        if (backfilled > 0) io.out(`已补算 ${backfilled} 条历史记忆的向量`);
        io.out(`✓ 语义检索已启用：${model} @ ${OLLAMA_HOST}/v1（写入 ${defaultConfigPath()}）`);
        io.out(`  所有 memobox 进程（含 MCP 服务）下次启动自动生效，无需重装客户端`);
        return 0;
      }
      if (sub === "disable") {
        if (process.env.EMBEDDING_API_BASE) {
          io.out("环境变量 EMBEDDING_API_BASE 还配着——它优先于配置文件；先从 shell / 客户端配置里删掉再 disable");
          return 0;
        }
        const cfg = loadConfig();
        if (!cfg.embedding) {
          io.out("本来就是关键词检索（没启用过语义模式）");
          return 0;
        }
        delete cfg.embedding;
        saveConfig(cfg);
        io.out("已停用语义检索，回到关键词模式（已算的向量留在库里不碍事；重启客户端生效）");
        return 0;
      }
      io.err("用法：memobox model <status|enable|disable> [--model 名]");
      return 1;
    }
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
      let rows = await makeStore().list(2000);
      if (text) rows = rows.filter((m) => m.content.toLowerCase().includes(text));
      if (kind) rows = rows.filter((m) => m.kind === kind);
      if (source) rows = rows.filter((m) => m.source === source);
      if (entity)
        rows = rows.filter((m) =>
          (m.entities ?? []).some((e) => e.toLowerCase() === entity.toLowerCase())
        );
      if (since !== undefined) rows = rows.filter((m) => m.createdAt >= since);
      const cut = rows.slice(0, limit);
      if (flags.has("json")) io.out(JSON.stringify(cut, null, 2));
      else if (cut.length === 0) io.out("(无结果)");
      else
        io.out(
          renderTable(
            cut.map((m) => ({
              id: m.id,
              created: new Date(m.createdAt).toISOString().slice(0, 10),
              kind: m.kind ?? "",
              entities: (m.entities ?? []).join(","),
              source: m.source ?? "",
              content: m.content,
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
        io.err(e instanceof Error ? e.message : String(e));
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
        io.err(`无法读取 ${file}：${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
      if (!parsed.ok) {
        io.err(`导入失败：${parsed.error}`);
        return 1;
      }
      const { imported, skipped } = await makeStore().importMemories(parsed.items);
      io.out(`导入完成：新增 ${imported} 条，跳过 ${skipped} 条（已存在）`);
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
              id: m.id,
              kind: m.kind ?? "",
              entities: (m.entities ?? []).join(","),
              content: m.content.split("\n")[0],
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
      const target = pos[1];
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
      console.error(`[memobox] fatal: ${e}`);
      process.exit(1);
    });
}
