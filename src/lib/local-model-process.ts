import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
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
    const current = spawn(process.execPath, ["--eval", worker], { env: { ...process.env, BUN_BE_BUN: "1", MEMOBOX_RUNTIME_PATH: optionalRuntimePath(), MEMOBOX_MODELS_PATH: modelCachePath() },
      cwd: optionalRuntimePath(), windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    child = current;
    current.stdin.on("error", stop);
    const lines = createInterface({ input: current.stdout }), progress = createInterface({ input: current.stderr });
    lines.on("line", line => {
      try {
        const response = JSON.parse(line), item = pending.get(response.id); if (!item) return;
        pending.delete(response.id); clearTimeout(item.timer);
        if (response.error) item.reject(failure());
        else if (!Array.isArray(response.vector) || response.vector.length !== 512 || response.vector.some((v: unknown) => typeof v !== "number" || !Number.isFinite(v))) item.reject(Error("内置模型返回无效向量"));
        else item.resolve(response.vector);
      } catch { stop(); }
    });
    progress.on("line", line => { try { const message = JSON.parse(line); if (typeof message.progress === "string") onProgress?.(message.progress); if (typeof message.diagnostic === "string") diagnostic = message.diagnostic.slice(-4000); } catch { diagnostic = (diagnostic + "\n" + line).slice(-4000); } });
    current.once("error", stop); current.once("exit", () => { if (child === current) { child = null; fail(); } lines.close(); progress.close(); });
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
