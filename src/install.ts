#!/usr/bin/env bun
/**
 * `memobox install <client>` —— 把 memobox 接进各 MCP 客户端（v2.0）。
 *
 * 支持三家：
 *   claude → 合并 ~/.claude.json 的用户级 MCP 接线
 *   codex  → 往 ~/.codex/config.toml 追加 [mcp_servers.memobox] 块
 *   pi     → MCP 配置 + 可自动发现的薄扩展（pi 不原生读取 mcp.json）
 *
 * 设计约束：
 * - 幂等：已配置过就明说，不重复追加；
 * - 只动自己那一小块配置（codex/pi 是合并写，不动用户其他条目）；
 * - 纯函数部分（块生成 / JSON 合并 / claude 参数拼装）独立导出，测试注入临时目录。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_COMPILED } from "./runtime";
import { writeInstallFile, removeCodexSection } from "./lib/install-file";
import piExtension from "./lib/pi-extension.txt" with { type: "text" };
import { TOOLS } from "./lib/mcp";
import { piAgentPath } from "./lib/paths";
import { isDeepStrictEqual } from "node:util";

export type ClientKind = "claude" | "codex" | "pi";

export type ServerEntry = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

/** 会被透传给被拉起进程的 env（语义检索配置，装了就带上） */
const PASSTHROUGH_ENV = [
  "MEMOBOX_DB_PATH",
  "MEMOBOX_CONFIG_PATH",
  "EMBEDDING_API_BASE",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIM",
  "EMBEDDING_TIMEOUT_MS",
  "HF_ENDPOINT",
  "MEMOBOX_RUNTIME_PATH",
  "MEMOBOX_MODELS_PATH",
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
    args: IS_COMPILED ? [] : [cliPath],
    env: Object.keys(env).length ? env : undefined,
  };
}

/** TOML 基本字符串兼容 JSON 的字符串转义，单引号路径也可解析。 */
const tomlString = (s: string) => JSON.stringify(s);

/** 生成 codex config.toml 的追加块（纯函数，测试直接断言文本） */
export function codexTomlBlock(entry: ServerEntry): string {
  const lines = [
    "",
    "[mcp_servers.memobox]",
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
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

/** 接线之外的解析结果必须保持，防止文本分段遗漏 TOML 特殊语法。 */
function unrelatedCodexSettings(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value }, servers = copy.mcp_servers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    const rest = { ...servers } as Record<string, unknown>; delete rest.memobox;
    if (Object.keys(rest).length) copy.mcp_servers = rest; else delete copy.mcp_servers;
  }
  return copy;
}

/** 写文件前把目录建好（~/.codex、~/.pi/agent 可能不存在） */
/** codex：往 ~/.codex/config.toml 追加块（幂等：见到标记就跳过） */
export async function installCodex(
  entry: ServerEntry,
  home: string = homedir(), force = false
): Promise<InstallResult> {
  const path = join(home, ".codex", "config.toml");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  let parsed: { mcp_servers?: { memobox?: unknown } };
  try { parsed = Bun.TOML.parse(existing) as typeof parsed; } catch { return { ok: false, message: "客户端 TOML 配置损坏，未修改：" + path }; }
  if (parsed.mcp_servers?.memobox && !force) {
    return { ok: true, message: `已配置过：${path} 里已有 [mcp_servers.memobox]；升级或修改路径后用 install codex --force 备份并更新` };
  }
  if (parsed.mcp_servers?.memobox && !CODEX_MARK.test(existing)) return { ok: false, message: "现有 memobox 使用非标准 TOML 段名，请先手动备份并移除该段：" + path };
  const next = (force ? removeCodexSection(existing) : existing) + codexTomlBlock(entry);
  try {
    const after = Bun.TOML.parse(next) as Record<string, unknown>;
    if (!isDeepStrictEqual(unrelatedCodexSettings(parsed), unrelatedCodexSettings(after))) return { ok: false, message: "接线更新将影响其他设置，未修改原文件，请手动核对：" + path };
  } catch { return { ok: false, message: "接线合并未通过 TOML 校验，未修改原文件：" + path }; }
  const backup = writeInstallFile(path, next);
  return { ok: true, message: `已写入 [mcp_servers.memobox] -> ${path}` + (backup ? "；原配置备份：" + backup : "") };
}

/** pi：合并 ~/.pi/agent/mcp.json（存在 memobox 键时视为已配置） */
export async function installPi(
  entry: ServerEntry,
  home: string = homedir(), force = false
): Promise<InstallResult> {
  const path = join(piAgentPath(home), "mcp.json");
  let existing: unknown = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return {
        ok: false,
        message: `${path} 不是合法 JSON——请先修复或备份，memobox 不会动它`,
      };
    }
  }
  const has = Boolean(
    existing &&
      typeof existing === "object" &&
      (existing as Record<string, unknown>).mcpServers &&
      ((existing as { mcpServers: Record<string, unknown> }).mcpServers.memobox !== undefined)
  );
  if (!existing || typeof existing !== "object" || Array.isArray(existing) || ((existing as { mcpServers?: unknown }).mcpServers !== undefined && (!((existing as { mcpServers: unknown }).mcpServers) || typeof (existing as { mcpServers: unknown }).mcpServers !== "object" || Array.isArray((existing as { mcpServers: unknown }).mcpServers)))) return { ok: false, message: "客户端配置必须是 JSON 对象，未修改：" + path };
  const extensionPath = join(piAgentPath(home), "extensions", "memobox.js");
  if (has && existsSync(extensionPath) && !force) return { ok: true, message: `已配置过：${path}；升级后用 install pi --force 更新并备份` };
  const extension = piExtension.replace("__MEMOBOX_CONFIG__", JSON.stringify(path)).replace("__MEMOBOX_TOOLS__", JSON.stringify(TOOLS));
  const extensionBackup = writeInstallFile(extensionPath, extension);
  const backup = has && !force ? undefined : writeInstallFile(path, JSON.stringify(piMerge(existing, entry), null, 2) + "\n");
  return { ok: true, message: `已写入 pi MCP 接线和自动加载扩展 -> ${path}` + (backup ? "；原配置备份：" + backup : "") + (extensionBackup ? "；扩展备份：" + extensionBackup : "") };
}

/** Claude 用户级 JSON 与官方 CLI 使用同一接线字段；无需启动 agent 写配置。 */
export async function installClaude(entry: ServerEntry, home: string = homedir(), force = false): Promise<InstallResult> {
  const path = join(home, ".claude.json"); let existing: unknown = {};
  try { if (existsSync(path)) existing = JSON.parse(readFileSync(path, "utf8")); }
  catch { return { ok: false, message: "Claude 配置不是合法 JSON，未修改：" + path }; }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return { ok: false, message: "Claude 配置必须是 JSON 对象，未修改：" + path };
  const servers = (existing as { mcpServers?: Record<string, unknown> }).mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) return { ok: false, message: "Claude mcpServers 必须是对象，未修改：" + path };
  if (servers?.memobox && !force) return { ok: true, message: "已配置过：" + path + "；升级后用 install claude --force 更新并备份" };
  const backup = writeInstallFile(path, JSON.stringify(piMerge(existing, entry), null, 2) + "\n");
  return { ok: true, message: "已接入 Claude Code（用户级配置）：" + path + (backup ? "；原配置备份：" + backup : "") };
}

export async function installClient(
  kind: ClientKind,
  entry: ServerEntry = serverEntry(), force = false
): Promise<InstallResult> {
  if (kind === "codex") return installCodex(entry, homedir(), force);
  if (kind === "pi") return installPi(entry, homedir(), force);
  return installClaude(entry, homedir(), force);
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
    detail: configured ? path : `${path} 没有 [mcp_servers.memobox] —— 运行 memobox install codex`,
  };
}

export function detectPi(home: string = homedir()): DetectResult {
  const path = join(home, ".pi", "agent", "mcp.json");
  if (!existsSync(path)) {
    return { client: "pi", configured: false, detail: `缺少 ${path} —— 运行 memobox install pi` };
  }
  try {
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    const configured = cfg.mcpServers?.memobox !== undefined;
    return {
      client: "pi",
      configured,
      detail: configured ? path : `${path} 没有 mcpServers.memobox —— 运行 memobox install pi`,
    };
  } catch {
    return { client: "pi", configured: false, detail: `${path} 不是合法 JSON` };
  }
}

export function detectClaude(home: string = homedir()): DetectResult {
  // user 级 MCP 配置在 ~/.claude.json 的 mcpServers 键里
  const path = join(home, ".claude.json");
  if (!existsSync(path)) {
    return { client: "claude", configured: false, detail: `缺少 ${path} —— 运行 memobox install claude` };
  }
  try {
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    const configured = cfg.mcpServers?.memobox !== undefined;
    return {
      client: "claude",
      configured,
      detail: configured ? path : `${path} 没有 memobox 条目 —— 运行 memobox install claude`,
    };
  } catch {
    return { client: "claude", configured: false, detail: `${path} 不是合法 JSON` };
  }
}
