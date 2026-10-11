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
import { readFileSync, writeFileSync } from "node:fs";
import { SQLiteStore } from "@/db/sqlite-store";
import { buildBackup, parseBackup } from "@/lib/backup";
import { defaultDbPath } from "@/lib/paths";
import type { Memory, MemoryStore } from "@/lib/memory-store";
import { installClient, type ClientKind } from "@/install";
import { serveStdio } from "@/mcp-server";

export const VERSION = "2.1.0";

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
