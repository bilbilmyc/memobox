#!/usr/bin/env bun
/**
 * `memobox install <client>` —— 把 memobox 接进各 MCP 客户端（v2.0）。
 *
 * 支持三家：
 *   claude → `claude mcp add --scope user`（依赖 PATH 上有 claude CLI）
 *   codex  → 往 ~/.codex/config.toml 追加 [mcp_servers.memobox] 块
 *   pi     → 合并 ~/.pi/agent/mcp.json 的 mcpServers.memobox 键
 *
 * 设计约束：
 * - 幂等：已配置过就明说，不重复追加；
 * - 只动自己那一小块配置（codex/pi 是合并写，不动用户其他条目）；
 * - 纯函数部分（块生成 / JSON 合并 / claude 参数拼装）独立导出，测试注入临时目录。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type ClientKind = "claude" | "codex" | "pi";

export type ServerEntry = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

/** 会被透传给被拉起进程的 env（语义检索配置，装了就带上） */
const PASSTHROUGH_ENV = [
  "EMBEDDING_API_BASE",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
] as const;

/**
 * 本机的 memobox 启动命令：bun 可执行 + 本包 cli.ts 绝对路径。
 * 用 process.execPath（当前解释器），全局安装 / 源码运行都成立。
 */
export function serverEntry(): ServerEntry {
  // cli.ts 与本文件同目录——按 import.meta.url 解析，不依赖 CWD
  const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return {
    command: process.execPath,
    args: [cliPath],
    env: Object.keys(env).length ? env : undefined,
  };
}

/** TOML 字面量字符串（单引号）：反斜杠不用转义，只需防单引号 */
const tomlLiteral = (s: string) => `'${s.replaceAll("'", "\\'")}'`;

/** 生成 codex config.toml 的追加块（纯函数，测试直接断言文本） */
export function codexTomlBlock(entry: ServerEntry): string {
  const lines = [
    "",
    "[mcp_servers.memobox]",
    `command = ${tomlLiteral(entry.command)}`,
    `args = [${entry.args.map(tomlLiteral).join(", ")}]`,
  ];
  if (entry.env) {
    const pairs = Object.entries(entry.env)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join(", ");
    lines.push(`env = { ${pairs} }`);
  }
  return lines.join("\n") + "\n";
}

/** 合并 pi 的 mcp.json（纯函数：返回新对象，不碰原对象） */
export function piMerge(
  existing: unknown,
  entry: ServerEntry
): { mcpServers: Record<string, unknown> } & Record<string, unknown> {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const servers = {
    ...((base.mcpServers as Record<string, unknown> | undefined) ?? {}),
    memobox: { command: entry.command, args: entry.args, ...(entry.env ? { env: entry.env } : {}) },
  };
  return { ...base, mcpServers: servers };
}

/** `claude mcp add` 的完整参数（纯函数；--scope user 全局可用） */
export function claudeAddArgs(entry: ServerEntry): string[] {
  const envFlags = Object.entries(entry.env ?? {}).flatMap(([k, v]) => [
    "--env",
    `${k}=${v}`,
  ]);
  return [
    "mcp",
    "add",
    "--scope",
    "user",
    ...envFlags,
    "memobox",
    "--",
    entry.command,
    ...entry.args,
  ];
}

export type InstallResult = { ok: boolean; message: string };

/** 已经配置过的判据：文本里出现过自己的键 */
const CODEX_MARK = /^\[mcp_servers\.memobox\]/m;

/** 写文件前把目录建好（~/.codex、~/.pi/agent 可能不存在） */
function writeCreatingDirs(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/** codex：往 ~/.codex/config.toml 追加块（幂等：见到标记就跳过） */
export async function installCodex(
  entry: ServerEntry,
  home: string = homedir()
): Promise<InstallResult> {
  const path = join(home, ".codex", "config.toml");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  if (CODEX_MARK.test(existing)) {
    return { ok: true, message: `already configured: ${path} contains [mcp_servers.memobox]` };
  }
  writeCreatingDirs(path, existing + codexTomlBlock(entry));
  return { ok: true, message: `added [mcp_servers.memobox] to ${path}` };
}

/** pi：合并 ~/.pi/agent/mcp.json（存在 memobox 键时视为已配置） */
export async function installPi(
  entry: ServerEntry,
  home: string = homedir()
): Promise<InstallResult> {
  const path = join(home, ".pi", "agent", "mcp.json");
  let existing: unknown = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return {
        ok: false,
        message: `${path} is not valid JSON — fix or back it up first, memobox will not touch it`,
      };
    }
  }
  const has = Boolean(
    existing &&
      typeof existing === "object" &&
      (existing as Record<string, unknown>).mcpServers &&
      ((existing as { mcpServers: Record<string, unknown> }).mcpServers.memobox !== undefined)
  );
  if (has) {
    return { ok: true, message: `already configured: ${path} has mcpServers.memobox` };
  }
  writeCreatingDirs(path, JSON.stringify(piMerge(existing, entry), null, 2) + "\n");
  return { ok: true, message: `added mcpServers.memobox to ${path}` };
}

/** claude：调官方 CLI 写配置；PATH 上没有时给手动片段降级 */
export async function installClaude(
  entry: ServerEntry
): Promise<InstallResult> {
  const args = claudeAddArgs(entry);
  const proc = Bun.spawn({
    cmd: ["claude", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code === 0) {
    return { ok: true, message: `claude mcp add ok: ${stdout.trim() || "memobox added (user scope)"}` };
  }
  // claude 不在 PATH 或执行失败——给等价手动命令
  return {
    ok: false,
    message: `could not run \`claude\` (exit ${code}: ${stderr.trim().split("\n")[0]}). Run manually:\n  claude ${args.join(" ")}`,
  };
}

export async function installClient(
  kind: ClientKind,
  entry: ServerEntry = serverEntry()
): Promise<InstallResult> {
  if (kind === "codex") return installCodex(entry);
  if (kind === "pi") return installPi(entry);
  return installClaude(entry);
}

// ---- 客户端接线探测（doctor 用；与安装器同一批路径和判据） ----

/** 各客户端「是否已配置 memobox」的探测结果 */
export type DetectResult = {
  client: ClientKind;
  configured: boolean;
  detail: string;
};

export function detectCodex(home: string = homedir()): DetectResult {
  const path = join(home, ".codex", "config.toml");
  const configured =
    existsSync(path) && CODEX_MARK.test(readFileSync(path, "utf-8"));
  return {
    client: "codex",
    configured,
    detail: configured ? path : `${path} has no [mcp_servers.memobox] — run: memobox install codex`,
  };
}

export function detectPi(home: string = homedir()): DetectResult {
  const path = join(home, ".pi", "agent", "mcp.json");
  if (!existsSync(path)) {
    return { client: "pi", configured: false, detail: `${path} missing — run: memobox install pi` };
  }
  try {
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    const configured = cfg.mcpServers?.memobox !== undefined;
    return {
      client: "pi",
      configured,
      detail: configured ? path : `${path} has no mcpServers.memobox — run: memobox install pi`,
    };
  } catch {
    return { client: "pi", configured: false, detail: `${path} is not valid JSON` };
  }
}

export function detectClaude(home: string = homedir()): DetectResult {
  // user 级 MCP 配置在 ~/.claude.json 的 mcpServers 键里
  const path = join(home, ".claude.json");
  if (!existsSync(path)) {
    return { client: "claude", configured: false, detail: `${path} missing — run: memobox install claude` };
  }
  try {
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    const configured = cfg.mcpServers?.memobox !== undefined;
    return {
      client: "claude",
      configured,
      detail: configured ? path : `${path} has no memobox entry — run: memobox install claude`,
    };
  } catch {
    return { client: "claude", configured: false, detail: `${path} is not valid JSON` };
  }
}
