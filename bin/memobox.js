#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { ensureBinary } from "./runtime.js";

try {
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  const binary = await ensureBinary(manifest, { progress: text => process.stderr.write(`[memobox] ${text}\n`) });
  const child = spawn(binary, process.argv.slice(2), { shell: false, windowsHide: true, stdio: "inherit" });
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => { if (!child.killed) child.kill(signal); }; handlers.set(signal, handler); process.on(signal, handler);
  }
  child.once("error", () => { console.error("memobox 启动失败：检查独立程序权限，或重新安装对应平台包。"); process.exitCode = 1; });
  child.once("exit", (code, signal) => {
    for (const [name, handler] of handlers) process.off(name, handler);
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  });
} catch (error) {
  console.error(`memobox 启动失败：${error instanceof Error ? error.message : "请检查安装"}\n网络受限时可从 GitHub Releases 下载同版本独立包，设置 MEMOBOX_BINARY_PATH 后运行。`);
  process.exitCode = 1;
}
