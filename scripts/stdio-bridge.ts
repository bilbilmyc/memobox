#!/usr/bin/env bun
/**
 * memobox stdio 桥 —— 给只支持 stdio 传输的 MCP 客户端用的本地适配器。
 *
 * 原理：memobox 的 /mcp 是无状态 POST-only 纯 JSON 服务，所以桥不需要
 * 复刻任何协议逻辑，只做「stdin 每行一条 JSON-RPC → POST 转发 → stdout
 * 回写」。服务端升级工具，桥自动跟进。
 *
 * 用法（客户端机器上只需装了 Bun，无需 clone 仓库）：
 *   MEMOBOX_URL=http://localhost:3100 bun stdio-bridge.ts
 *   # 服务端配了 MCP_TOKEN 时，同值设 MEMOBOX_TOKEN 即可带上认证
 *   # Claude Code 接入：
 *   claude mcp add memobox --env MEMOBOX_URL=http://your-server:3100 -- bun /path/to/stdio-bridge.ts
 *
 * 本文件刻意自包含（零依赖），方便单文件分发；核心函数同时被单测 import
 * （import.meta.main 只在直接执行时启动 stdin 循环）。
 */
import { createInterface } from "node:readline";

/** memobox 服务地址，默认本机 dev/容器端口 */
const MEMOBOX_URL = process.env.MEMOBOX_URL ?? "http://localhost:3100";
/** 服务端配了 MCP_TOKEN 时，桥用同一个令牌做 Bearer 认证 */
const MEMOBOX_TOKEN = process.env.MEMOBOX_TOKEN;

/** 一行输入的处理结果：null = 保持沉默（通知/空行），string = 要写回 stdout 的一行 */
export type LineOutcome = string | null;

type FetchLike = typeof fetch;

/** 消息头：声明纯 JSON 模式（不要 SSE），无状态不需要会话 id */
const rpcHeaders: Record<string, string> = {
  "content-type": "application/json",
  accept: "application/json",
  ...(MEMOBOX_TOKEN ? { authorization: `Bearer ${MEMOBOX_TOKEN}` } : {}),
};

/** 从原始报文里抠出 id，用于错误响应的关联（抠不出就 null） */
function idOf(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    return parsed?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * 转发单条 JSON-RPC 报文。
 * - 202（通知被服务端吞掉）→ skip
 * - 网络层失败 → 合成 -32603 internal error 响应（对齐 JSON-RPC 语义，客户端能看到原因）
 */
export async function postRpc(
  url: string,
  raw: string,
  fetchFn: FetchLike = fetch
): Promise<{ skip: boolean; body?: unknown }> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: rpcHeaders,
      body: raw,
    });
  } catch (e) {
    return {
      skip: false,
      body: {
        jsonrpc: "2.0",
        id: idOf(raw),
        error: {
          code: -32603,
          message: `memobox bridge: cannot reach ${url} (${
            e instanceof Error ? e.message : String(e)
          })`,
        },
      },
    };
  }
  if (res.status === 202) return { skip: true };
  try {
    return { skip: false, body: await res.json() };
  } catch {
    // 非 JSON 响应（如 401/500 的纯文本）：合成错误报文而不是让桥崩掉
    return {
      skip: false,
      body: {
        jsonrpc: "2.0",
        id: idOf(raw),
        error: {
          code: -32603,
          message: `memobox bridge: HTTP ${res.status} from ${url} (non-JSON response)`,
        },
      },
    };
  }
}

/**
 * 处理 stdin 的一行：
 * - 空行 → 沉默
 * - 非法 JSON → -32700
 * - 批量（数组）→ 逐条转发后重组数组；全通知则沉默（JSON-RPC 批量语义）
 * - 单条 → 直接转发
 */
export async function handleLine(
  url: string,
  line: string,
  fetchFn: FetchLike = fetch
): Promise<LineOutcome> {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "memobox bridge: parse error" },
    });
  }

  // 批量报文：服务端不收数组，桥负责拆开逐条转发再拼回数组
  if (Array.isArray(msg)) {
    const out: unknown[] = [];
    for (const item of msg) {
      const raw = JSON.stringify(item);
      const r = await postRpc(url, raw, fetchFn);
      if (!r.skip) out.push(r.body);
    }
    return out.length ? JSON.stringify(out) : null;
  }

  const r = await postRpc(url, trimmed, fetchFn);
  return r.skip ? null : JSON.stringify(r.body);
}

/** 主循环：逐行读 stdin，逐行写 stdout；诊断信息走 stderr 不污染协议流 */
async function main() {
  const url = `${MEMOBOX_URL.replace(/\/$/, "")}/mcp`;
  console.error(`[memobox bridge] forwarding stdin -> ${url}`);

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const outcome = await handleLine(url, line);
    if (outcome !== null) process.stdout.write(outcome + "\n");
  }
  // stdin 关闭即退出（客户端断开）
}

// 直接执行才启动循环；被单测 import 时只暴露纯函数
if (import.meta.main) {
  main().catch((e) => {
    console.error(`[memobox bridge] fatal: ${e}`);
    process.exit(1);
  });
}
