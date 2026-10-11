#!/usr/bin/env bun
/**
 * memobox CLI（v2.0）—— 给 AI agent 的本地长期记忆，一个命令搞定。
 *
 * 无参数 = stdio MCP 服务（给 Claude Code / Codex / pi 拉起用）；
 * 带子命令 = 人直接操作记忆库。
 *
 *   memobox                        # stdio MCP 服务（等价 `memobox serve`）
 *   memobox save "text" [--kind fact] [--entities a,b] [--source x]
 *   memobox search "query" [--limit 5]
 *   memobox list [--limit 20]
 *   memobox forget <id>
 *   memobox stats
 *   memobox entities [--limit 20]
 *   memobox path                   # 打印库文件位置
 *   memobox export <file.json>     # 全量备份（memobox-backup v1 格式）
 *   memobox import <file.json>     # 幂等导入
 *   memobox install claude|codex|pi
 *
 * runCli 把 argv / 输出 / store 全部注入，单测不起真进程；
 * import.meta.main 时才接 process。env：MEMOBOX_DB_PATH 改库文件，
 * EMBEDDING_API_* 启用语义检索（不配 = 关键词模式）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { SQLiteStore } from "@/db/sqlite-store";
import { buildBackup, parseBackup } from "@/lib/backup";
import { defaultDbPath } from "@/lib/paths";
import type { Memory, MemoryStore } from "@/lib/memory-store";
import { detectClaude, detectCodex, detectPi, installClient, type ClientKind } from "@/install";
import { serveStdio } from "@/mcp-server";

export const VERSION = "2.2.0";

const USAGE = `memobox ${VERSION} — local long-term memory for AI agents

usage:
  memobox                              stdio MCP server (for MCP clients)
  memobox serve                        same as above, explicit
  memobox save <text> [--kind fact|preference|event|decision]
                   [--entities a,b] [--source name]
  memobox search <query> [--limit 5]
  memobox list [--limit 20]
  memobox forget <id>
  memobox entities [--limit 20]
  memobox stats
  memobox path                         print database file location
  memobox doctor                       health check: db, retrieval, client wiring
  memobox query [text] [--kind k] [--entity e] [--source s]
                   [--since 7d|2026-01-01] [--limit 20] [--json]
  memobox get <id>                     show one memory in full (JSON)
  memobox sql "SELECT ..."             read-only SQL over the SQLite db [--json]
  memobox export <file.json>           export all memories (backup)
  memobox import <file.json>           import backup (idempotent)
  memobox install <claude|codex|pi>    wire up an MCP client

env:
  MEMOBOX_DB_PATH    database file (default ~/.memobox/memobox.db)
  EMBEDDING_API_*    OpenAI-compatible /embeddings endpoint for
                     semantic search (unset = keyword mode)`;

/** 极简参数解析：位置参数按序收集，--flag 值成对收集 */
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
      flags.set(argv[i].slice(2), ""); // 布尔旗标（当前未用，留个底）
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
  if (rows.length === 0) return "(no rows)";
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
  makeStore: () => MemoryStore
): Promise<number> {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos[0] ?? "serve";

  switch (cmd) {
    case "serve": {
      await serveStdio(makeStore());
      return 0;
    }
    case "save": {
      const content = pos.slice(1).join(" ");
      if (!content) {
        io.err('usage: memobox save <text> [--kind ...] [--entities a,b]');
        return 1;
      }
      const row = await makeStore().save({
        content,
        kind: flags.get("kind") as SaveInput["kind"] | undefined,
        entities: flags.get("entities")?.split(",").map((s) => s.trim()).filter(Boolean),
        source: flags.get("source") ?? "cli",
      });
      io.out(`saved memory ${row.id}`);
      return 0;
    }
    case "search": {
      const query = pos.slice(1).join(" ");
      if (!query) {
        io.err("usage: memobox search <query> [--limit 5]");
        return 1;
      }
      const limit = Number(flags.get("limit") ?? 5) || 5;
      const hits = await makeStore().search(query, limit);
      if (hits.length === 0) io.out("no matching memories");
      else hits.forEach((h) => io.out(renderMemory(h)));
      return 0;
    }
    case "list": {
      const limit = Number(flags.get("limit") ?? 20) || 20;
      const rows = await makeStore().list(limit);
      if (rows.length === 0) io.out("no memories yet — save one with: memobox save <text>");
      else rows.forEach((h) => io.out(renderMemory(h)));
      return 0;
    }
    case "forget": {
      const id = pos[1];
      if (!id) {
        io.err("usage: memobox forget <id>");
        return 1;
      }
      const ok = await makeStore().forget(id);
      io[ok ? "out" : "err"](ok ? `forgot memory ${id}` : `not found: ${id}`);
      return ok ? 0 : 1;
    }
    case "entities": {
      const limit = Number(flags.get("limit") ?? 20) || 20;
      const rows = await makeStore().topEntities(limit);
      if (rows.length === 0) io.out("no entities yet");
      else rows.forEach((e) => io.out(`${e.name} (${e.memories})`));
      return 0;
    }
    case "stats": {
      const { total, searches } = await makeStore().stats();
      io.out(`${total} memories, ${searches} searches — db: ${defaultDbPath()}`);
      return 0;
    }
    case "path": {
      io.out(defaultDbPath());
      return 0;
    }
    case "query": {
      // 结构化过滤（AND 组合）：文本子串 + kind/source 精确 + entity 包含 + 时间下限
      const text = pos.slice(1).join(" ").toLowerCase() || undefined;
      const sinceRaw = flags.get("since");
      const since = sinceRaw !== undefined ? parseSince(sinceRaw) : undefined;
      if (Number.isNaN(since)) {
        io.err(`bad --since "${sinceRaw}" — use 7d / 12h / 30m or an ISO date`);
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
      else if (cut.length === 0) io.out("(no rows)");
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
        io.err("usage: memobox get <id>");
        return 1;
      }
      const m = await makeStore().get(id);
      if (!m) {
        io.err(`not found: ${id}`);
        return 1;
      }
      io.out(JSON.stringify(m, null, 2));
      return 0;
    }
    case "sql": {
      // 只读 SQL 透传：直接查 SQLite 本体（schema 见 --json 的列名或源码）
      const stmt = pos.slice(1).join(" ");
      if (!stmt) {
        io.err('usage: memobox sql "SELECT ..." [--json]');
        return 1;
      }
      if (!/^\s*(select|with|pragma)\b/i.test(stmt)) {
        io.err("read-only: only SELECT / WITH / PRAGMA statements are allowed");
        return 1;
      }
      let db: Database;
      try {
        db = new Database(defaultDbPath(), { readonly: true });
      } catch {
        io.err(`cannot open ${defaultDbPath()} — save a memory first`);
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
    case "doctor": {
      // 自检：库文件 + 检索模式 + 三家客户端接线情况，一眼定位「agent 怎么不记事」
      const dbPath = defaultDbPath();
      if (existsSync(dbPath)) {
        const store = makeStore();
        const { total, searches } = await store.stats();
        io.out(`db:        ${dbPath} (${total} memories, ${searches} searches)`);
        io.out(`retrieval: ${store.retrieval}${store.retrieval === "keyword" ? " (set EMBEDDING_API_* for semantic)" : ""}`);
      } else {
        io.out(`db:        ${dbPath} (not created yet — first save creates it)`);
        io.out(`retrieval: ${process.env.EMBEDDING_API_BASE ? "semantic" : "keyword (set EMBEDDING_API_* for semantic)"}`);
      }
      for (const d of [detectCodex(), detectPi(), detectClaude()]) {
        io.out(`${d.client}:${" ".repeat(Math.max(1, 9 - d.client.length))}${d.configured ? "configured  " : "NOT wired    "}${d.detail}`);
      }
      return 0;
    }
    case "export": {
      const file = pos[1];
      if (!file) {
        io.err("usage: memobox export <file.json>");
        return 1;
      }
      const backup = buildBackup(await makeStore().exportAll());
      writeFileSync(file, JSON.stringify(backup, null, 2), "utf-8");
      io.out(`exported ${backup.memories.length} memories -> ${file}`);
      return 0;
    }
    case "import": {
      const file = pos[1];
      if (!file) {
        io.err("usage: memobox import <file.json>");
        return 1;
      }
      let parsed;
      try {
        parsed = parseBackup(readFileSync(file, "utf-8"));
      } catch (e) {
        io.err(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
      if (!parsed.ok) {
        io.err(`import failed: ${parsed.error}`);
        return 1;
      }
      const { imported, skipped } = await makeStore().importMemories(parsed.items);
      io.out(`import done: ${imported} added, ${skipped} skipped (already present)`);
      return 0;
    }
    case "install": {
      const client = pos[1] as ClientKind | undefined;
      if (client !== "claude" && client !== "codex" && client !== "pi") {
        io.err("usage: memobox install <claude|codex|pi>");
        return 1;
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
    case "-h":
      io.out(USAGE);
      return 0;
    default:
      io.err(`unknown command: ${cmd}\n\n${USAGE}`);
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
