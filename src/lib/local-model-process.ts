import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import worker from "./local-model-worker.txt" with { type: "text" };
import { optionalRuntimePath, modelCachePath } from "./optional-runtime";
import { redactDetails } from "./diagnostics";

/** 按需常驻于所属 CLI/MCP 进程；无端口，无共享服务，不能遗留孤儿模型进程。 */
export function createLocalModelProcess(onProgress?: (message: string) => void) {
  let child: ChildProcessWithoutNullStreams | null = null, sequence = 0;
  let diagnostic = "";
  const pending = new Map<number, { resolve: (vector: number[]) => void; reject: (error: Error) => void; timer: Timer }>();
  const failure = () => Error("内置模型加载/推理失败" + (diagnostic ? ": " + redactDetails(diagnostic) : ""));
  const fail = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure()); } pending.clear(); };
  const stop = () => { child?.stdin.end(); child?.kill(); child = null; fail(); };
  process.once("exit", stop);
  function start() {
    diagnostic = "";
    // Windows 的 Bun 父进程直接拉起 BUN_BE_BUN 子进程会额外等待约 3 秒。
    // 用系统 cmd 仅转交进程创建；命令文本固定，查询仍只通过 stdin 传输。
    // 禁用二次展开与 AutoRun，源码以 base64 环境变量交给模块加载器，避免临时文件。
    const windows = process.platform === "win32";
    const command = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe") : process.execPath;
    const args = windows ? ["/d", "/v:off", "/s", "/c", '""%MEMOBOX_WORKER_EXECUTABLE%" --no-env-file --eval "import(\'data:text/javascript;base64,\'+process.env.MEMOBOX_WORKER_SOURCE)""'] : ["--no-env-file", "--eval", worker];
    const current = spawn(command, args, { env: { ...process.env, BUN_BE_BUN: "1", MEMOBOX_RUNTIME_PATH: optionalRuntimePath(), MEMOBOX_MODELS_PATH: modelCachePath(),
      ...(windows ? { MEMOBOX_WORKER_EXECUTABLE: process.execPath, MEMOBOX_WORKER_SOURCE: Buffer.from(worker).toString("base64") } : {}) },
      cwd: optionalRuntimePath(), windowsHide: true, windowsVerbatimArguments: windows, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    child = current;
    const disconnect = () => { if (child === current) stop(); };
    current.stdin.on("error", disconnect);
    const lines = createInterface({ input: current.stdout }), progress = createInterface({ input: current.stderr });
    lines.on("line", line => {
      try {
        const response = JSON.parse(line), item = pending.get(response.id); if (!item) return;
        pending.delete(response.id); clearTimeout(item.timer);
        if (response.error) { item.reject(failure()); return; }
        const bytes = typeof response.vectorBase64 === "string" && response.vectorBase64.length <= 2800 ? Buffer.from(response.vectorBase64, "base64") : null;
        if (!bytes || bytes.length !== 512 * 4) { item.reject(Error("内置模型返回无效向量")); return; }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const vector = Array.from({ length: 512 }, (_, index) => view.getFloat32(index * 4, true));
        if (vector.some(value => !Number.isFinite(value))) item.reject(Error("内置模型返回无效向量")); else item.resolve(vector);
      } catch { disconnect(); }
    });
    progress.on("line", line => { try { const message = JSON.parse(line); if (typeof message.progress === "string") onProgress?.(message.progress); if (typeof message.diagnostic === "string") diagnostic = message.diagnostic.slice(-4000); } catch { diagnostic = (diagnostic + "\n" + line).slice(-4000); } });
    current.once("error", disconnect); current.once("exit", () => { if (child === current) { child = null; fail(); } lines.close(); progress.close(); });
    return current;
  }
  return { stop, embed(text: string): Promise<number[]> {
    const current = child ?? start(), id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(Error("内置模型首次加载超时，请检查网络后重试")); }, 180000);
      pending.set(id, { resolve, reject, timer }); current.stdin.write(JSON.stringify({ id, text }) + "\n");
    });
  } };
}
