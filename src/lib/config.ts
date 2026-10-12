/**
 * memobox 自己的配置文件：~/.memobox/config.json（v2.4）。
 *
 * 用途：`memobox model enable` 把语义检索配置写进这里，之后每个
 * memobox 进程（CLI 与被客户端拉起的 MCP 服务）启动时都会读它——
 * 不依赖环境变量，也不用重新 install 客户端。
 * 环境变量 EMBEDDING_API_* 仍然优先（老用法不变）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type MemoboxConfig = {
  /**
   * 语义检索配置（`memobox model enable` / 手动维护）。
   * 两种互斥形态：端点模式（base）或内置模型模式（local，v2.5）。
   */
  embedding?: {
    /** OpenAI 兼容 /embeddings 端点（Ollama / 云端） */
    base?: string;
    model?: string;
    /** 云端端点才需要；本地端点免鉴权 */
    key?: string;
    /** 本机小模型，按需安装运行库和模型；`model enable --lite` 写入 */
    local?: boolean;
    dimensions?: number;
    timeoutMs?: number;
  };
};

export const CONFIG_KEYS = ["embedding.base", "embedding.model", "embedding.key", "embedding.local", "embedding.dimensions", "embedding.timeoutMs"] as const;
export type ConfigKey = typeof CONFIG_KEYS[number];
export class ConfigValidationError extends Error {}
export function parseConfigValue(key: string, value: string): string | boolean | number {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) throw new ConfigValidationError("未知配置项，请查看 memobox config --help");
  if (key === "embedding.local") {
    if (!["true", "false"].includes(value)) throw new ConfigValidationError("embedding.local 只能是 true 或 false");
    return value === "true";
  }
  if (key === "embedding.dimensions") {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 65536) throw new ConfigValidationError("向量维度必须是 1–65536 的整数");
    return Number(value);
  }
  if (key === "embedding.timeoutMs") {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 100 || Number(value) > 120000) throw new ConfigValidationError("嵌入请求超时必须是 100–120000 毫秒的整数");
    return Number(value);
  }
  if (key !== "embedding.key" && !value.trim()) throw new ConfigValidationError("配置值不能为空");
  if (key === "embedding.base") {
    try { if (!["http:", "https:"].includes(new URL(value).protocol)) throw Error(); }
    catch { throw new ConfigValidationError("嵌入端点必须是有效的 http/https 地址"); }
  }
  return value;
}

function validateConfig(value: unknown): asserts value is MemoboxConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigValidationError("配置必须是 JSON 对象");
  const embedding = (value as MemoboxConfig).embedding;
  if (embedding === undefined) return;
  if (!embedding || typeof embedding !== "object" || Array.isArray(embedding)) throw new ConfigValidationError("embedding 配置必须是对象");
  for (const key of CONFIG_KEYS) {
    const name = key.split(".")[1] as keyof typeof embedding;
    const current = embedding[name];
    if (current === undefined) continue;
    const expected = name === "local" ? "boolean" : name === "dimensions" || name === "timeoutMs" ? "number" : "string";
    if (typeof current !== expected) throw new ConfigValidationError("配置项 " + key + " 的类型不正确");
    parseConfigValue(key, String(current));
  }
  if (embedding.local && embedding.base) throw new ConfigValidationError("内置模型和端点模式不能同时启用；先重置另一模式的配置项");
}

export function readConfig(path = defaultConfigPath()): { ok: true; config: MemoboxConfig } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, config: {} };
  try { const parsed: unknown = JSON.parse(readFileSync(path, "utf8")); validateConfig(parsed); return { ok: true, config: parsed }; }
  catch (error) { return { ok: false, error: error instanceof ConfigValidationError ? error.message : "配置文件无法读取或不是合法 JSON" }; }
}

/** 配置文件位置：env 可覆盖（测试用），默认跟库文件同目录 */
export function defaultConfigPath(): string {
  return process.env.MEMOBOX_CONFIG_PATH || join(homedir(), ".memobox", "config.json");
}

/** 读取配置；文件不存在 / 内容损坏都按空配置处理（不抛错） */
export function loadConfig(path: string = defaultConfigPath()): MemoboxConfig {
  const result = readConfig(path);
  if (result.ok) return result.config;
  console.error("[memobox] " + result.error + "；忽略文件中的模型设置。请用 memobox config show 查看，或 config reset 保留备份后重置。");
  return {};
}

/** 同目录临时文件 + 原子替换；写失败时保留原文件，不留下半份 JSON。 */
export function saveConfig(cfg: MemoboxConfig, path: string = defaultConfigPath()): void {
  validateConfig(cfg);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
