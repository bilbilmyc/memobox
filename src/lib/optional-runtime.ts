import { existsSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { IS_COMPILED } from "../runtime";

export const OPTIONAL_TRANSFORMERS_VERSION = "4.3.1";
export const optionalRuntimePath = () => process.env.MEMOBOX_RUNTIME_PATH || join(homedir(), ".memobox", "runtime");
export const modelCachePath = () => process.env.MEMOBOX_MODELS_PATH || join(homedir(), ".memobox", "models");

/** 原生程序的外部模块从真实磁盘解析，不依赖 $bunfs 虚拟源码目录。 */
export function localRuntimeEntry(): string | null {
  try {
    if (IS_COMPILED || process.env.MEMOBOX_RUNTIME_PATH) {
      const entry = join(optionalRuntimePath(), "node_modules", "@huggingface", "transformers", "dist", "transformers.node.cjs");
      const binding = join(optionalRuntimePath(), "node_modules", "onnxruntime-node", "bin", "napi-v6", process.platform, process.arch, "onnxruntime_binding.node");
      return existsSync(entry) && existsSync(binding) ? entry : null;
    }
    const base = IS_COMPILED || process.env.MEMOBOX_RUNTIME_PATH ? join(optionalRuntimePath(), "package.json") : import.meta.url;
    return createRequire(base).resolve("@huggingface/transformers");
  } catch { return null; }
}

/** 仅由显式 model enable --lite 调用；MCP 冷启和 doctor 不安装/加载 ML。 */
export async function installLocalRuntime(onProgress?: (message: string) => void): Promise<void> {
  if (localRuntimeEntry()) return;
  const directory = optionalRuntimePath(); mkdirSync(directory, { recursive: true });
  const lockPath = join(directory, "install.lock");
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let dead = false;
    try { const owner = JSON.parse(readFileSync(lockPath, "utf8")); if (Number.isInteger(owner.pid) && owner.pid > 0) process.kill(owner.pid, 0); }
    catch (ownerError) { dead = (ownerError as NodeJS.ErrnoException).code === "ESRCH"; }
    if (!dead) throw Error("其他进程正在安装可选模型依赖；等待完成后重试。若上次安装被中断，确认无安装进程后移除 " + lockPath);
    unlinkSync(lockPath); lock = openSync(lockPath, "wx", 0o600);
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  try {
  const packageFile = join(directory, "package.json");
  const overrides = process.platform === "darwin" && process.arch === "x64" ? { "onnxruntime-node": "1.23.2" } : {};
  if (!existsSync(packageFile)) writeFileSync(packageFile, JSON.stringify({ name: "memobox-optional-runtime", private: true, overrides }, null, 2), { flag: "wx", mode: 0o600 });
  else if (Object.keys(overrides).length) {
    const existing = JSON.parse(readFileSync(packageFile, "utf8"));
    if (existing.name !== "memobox-optional-runtime") throw Error("macOS Intel 需要兼容的 ONNX 运行时；请将 MEMOBOX_RUNTIME_PATH 指向独立的 memobox 模型依赖目录");
    writeFileSync(packageFile, JSON.stringify({ ...existing, overrides: { ...existing.overrides, ...overrides } }, null, 2), { mode: 0o600 });
  }
  onProgress?.("按需安装内置模型依赖到 " + directory + "（不包含在基础发行包中）");
  const child = spawn(process.execPath, ["add", "--cwd", directory, "--exact", "--ignore-scripts", `@huggingface/transformers@${OPTIONAL_TRANSFORMERS_VERSION}`],
    { env: { ...process.env, ...(IS_COMPILED ? { BUN_BE_BUN: "1" } : {}) }, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume();
  const code = await new Promise<number | null>((resolveCode, reject) => { child.once("error", reject); child.once("close", resolveCode); });
  if (code !== 0 || !localRuntimeEntry()) throw Error("可选模型依赖安装失败；检查网络/目录权限后重试 model enable --lite");
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
