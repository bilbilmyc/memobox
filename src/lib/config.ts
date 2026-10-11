/**
 * memobox 自己的配置文件：~/.memobox/config.json（v2.4）。
 *
 * 用途：`memobox model enable` 把语义检索配置写进这里，之后每个
 * memobox 进程（CLI 与被客户端拉起的 MCP 服务）启动时都会读它——
 * 不依赖环境变量，也不用重新 install 客户端。
 * 环境变量 EMBEDDING_API_* 仍然优先（老用法不变）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type MemoboxConfig = {
  /** 语义检索配置（`memobox model enable` / 手动维护） */
  embedding?: {
    base: string;
    model: string;
    /** 云端端点才需要；本地 Ollama 留空 */
    key?: string;
  };
};

/** 配置文件位置：env 可覆盖（测试用），默认跟库文件同目录 */
export function defaultConfigPath(): string {
  return process.env.MEMOBOX_CONFIG_PATH ?? join(homedir(), ".memobox", "config.json");
}

/** 读取配置；文件不存在 / 内容损坏都按空配置处理（不抛错） */
export function loadConfig(path: string = defaultConfigPath()): MemoboxConfig {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as MemoboxConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // 配置写坏了不该让 memobox 整个起不来——按空配置跑（keyword 模式）
    return {};
  }
}

/** 写配置（原子性靠 writeFileSync 覆盖；文件小无所谓） */
export function saveConfig(cfg: MemoboxConfig, path: string = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}
