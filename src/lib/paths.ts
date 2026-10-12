import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 默认库文件位置：~/.memobox/memobox.db（v2.0 起）。
 * env 优先——MEMOBOX_DB_PATH 既被这里读、也被 SQLiteStore 构造器读，
 * 客户端配置里可以用 env 块指向任意路径。
 */
export function defaultDbPath(): string {
  return process.env.MEMOBOX_DB_PATH || join(homedir(), ".memobox", "memobox.db");
}

/** 显式测试 home 不读取用户 pi 目录；实际安装尊重 pi 的官方目录覆盖。 */
export function piAgentPath(home = homedir()): string {
  return home === homedir() && process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(home, ".pi", "agent");
}
