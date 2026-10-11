#!/usr/bin/env bun
/**
 * memobox stdio MCP 服务（v2.0，吸收自 v1.7 的 scripts/mcp-local.ts）。
 *
 * 无端口、无守护进程：MCP 客户端（Claude Code / Codex / pi…）直接把本
 * 进程当 MCP server 拉起，stdin 进 JSON-RPC、stdout 出结果。协议逻辑
 * 复用 src/lib/mcp.ts 的 handleRpcBody——与所有客户端走同一条代码路径。
 * 存储是本地 SQLite 文件（默认 ~/.memobox/memobox.db）。
 *
 * 由 src/cli.ts 在无参数 / serve 子命令时调用；也可直接：
 *   bun src/mcp-server.ts
 */
import { createInterface } from "node:readline";
import { SQLiteStore } from "@/db/sqlite-store";
import { handleRpcBody } from "@/lib/mcp";
import { defaultDbPath } from "@/lib/paths";
import type { MemoryStore } from "@/lib/memory-store";

/**
 * 处理 stdin 的一行：
 * - 空行 → 沉默（null）
 * - 非法 JSON → -32700
 * - 批量（数组）→ 逐条处理后重组
 * - 单条 → 走 handleRpcBody（与所有传输同一条协议路径）
 */
export async function handleLine(
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
      error: { code: -32700, message: "memobox: parse error" },
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

/** 主循环：逐行读 stdin，逐行写 stdout；诊断信息走 stderr 不污染协议流 */
export async function serveStdio(store?: MemoryStore): Promise<void> {
  // embedder 走构造器默认（createEmbedder 读 env，配了 EMBEDDING_API_* 即语义模式）
  const s = store ?? new SQLiteStore(undefined, defaultDbPath());
  console.error(`[memobox] stdio MCP server ready, db: ${defaultDbPath()}`);
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const outcome = await handleLine(s, line);
    if (outcome !== null) process.stdout.write(outcome + "\n");
  }
  // stdin 关闭即退出（客户端断开）
}
