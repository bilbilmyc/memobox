#!/usr/bin/env bun
/**
 * memobox 本地模式 —— 直连 stdio 的 MCP 服务（v1.7）。
 *
 * 不起 Next、不开端口、不需要 Postgres：MCP 客户端（Codex / Claude Code /
 * Cursor…）直接把这个脚本当 MCP server 拉起，存储是本地 SQLite 文件。
 * 协议逻辑复用 src/lib/mcp.ts（与 HTTP 端点同一份代码），存储复用
 * SQLiteStore——本地规模 JS 余弦语义检索（配 EMBEDDING_API_* 即启用）。
 *
 * Codex 接入（~/.codex/config.toml）：
 *   [mcp_servers.memobox]
 *   command = 'C:\Users\you\.bun\bin\bun.exe'
 *   args = ['D:/memobox/scripts/mcp-local.ts']
 *
 * Claude Code 接入：
 *   claude mcp add memobox -- bun /path/to/mcp-local.ts
 *
 * 库文件默认 <仓库>/data/memobox.db（MEMOBOX_DB_PATH 可改；注意默认按
 * 脚本位置解析而不是 CWD——客户端拉起进程时 CWD 不可控）。
 *
 * 备份/迁移不依赖 web：
 *   bun scripts/mcp-local.ts --export backup.json
 *   bun scripts/mcp-local.ts --import backup.json
 */
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SQLiteStore } from "../src/db/sqlite-store";
import { handleRpcBody } from "../src/lib/mcp";
import { buildBackup, parseBackup } from "../src/lib/backup";
import type { MemoryStore } from "../src/lib/memory-store";

/** 库文件位置：env 优先，否则按脚本所在仓库解析（CWD 不可控） */
const DB_PATH =
  process.env.MEMOBOX_DB_PATH ??
  fileURLToPath(new URL("../data/memobox.db", import.meta.url));

/**
 * 处理 stdin 的一行：
 * - 空行 → 沉默（null）
 * - 非法 JSON → -32700
 * - 批量（数组）→ 逐条处理后重组（HTTP 端点不收数组，这里同样拆开）
 * - 单条 → 走 handleRpcBody（与 /mcp 完全同一条协议路径）
 */
export async function handleLocal(
  store: MemoryStore,
  line: string
): Promise<string | null> {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "memobox local: parse error" },
    });
  }

  const one = async (raw: string): Promise<unknown | null> => {
    const { status, body } = await handleRpcBody(raw, store);
    return status === 202 ? null : body;
  };

  if (Array.isArray(msg)) {
    const out: unknown[] = [];
    for (const item of msg) {
      const body = await one(JSON.stringify(item));
      if (body !== null) out.push(body);
    }
    return out.length ? JSON.stringify(out) : null;
  }
  const body = await one(trimmed);
  return body === null ? null : JSON.stringify(body);
}

/** --export / --import：一次性跑完退出（CLI 场景，stdout 给人看） */
async function runFileCommand(argv: string[], store: MemoryStore) {
  const [cmd, path] = argv;
  if (cmd === "--export" && path) {
    const backup = buildBackup(await store.exportAll());
    writeFileSync(path, JSON.stringify(backup, null, 2), "utf-8");
    console.log(`[memobox] 已导出 ${backup.memories.length} 条记忆 -> ${path}`);
    return;
  }
  if (cmd === "--import" && path) {
    const parsed = parseBackup(readFileSync(path, "utf-8"));
    if (!parsed.ok) {
      console.error(`[memobox] 导入失败：${parsed.error}`);
      process.exit(1);
    }
    const { imported, skipped } = await store.importMemories(parsed.items);
    console.log(`[memobox] 导入完成：新增 ${imported} 条，跳过 ${skipped} 条`);
    return;
  }
  console.error(
    "用法：\n  bun scripts/mcp-local.ts                 # stdio MCP 服务\n" +
      "  bun scripts/mcp-local.ts --export <file>  # 导出备份\n" +
      "  bun scripts/mcp-local.ts --import <file>  # 导入备份"
  );
  process.exit(cmd ? 1 : 0);
}

/** 主循环：逐行读 stdin，逐行写 stdout；诊断信息走 stderr 不污染协议流 */
async function main() {
  const argv = process.argv.slice(2);
  // embedder 走构造器默认（createEmbedder 读 env，配了 EMBEDDING_API_* 即语义模式）
  const store = new SQLiteStore(undefined, DB_PATH);
  if (argv.length > 0) return runFileCommand(argv, store);

  console.error(`[memobox local] stdio MCP 服务就绪，库文件: ${DB_PATH}`);
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const outcome = await handleLocal(store, line);
    if (outcome !== null) process.stdout.write(outcome + "\n");
  }
  // stdin 关闭即退出（客户端断开）
}

// 直接执行才启动循环；被单测 import 时只暴露纯函数
if (import.meta.main) {
  main().catch((e) => {
    console.error(`[memobox local] fatal: ${e}`);
    process.exit(1);
  });
}
