/**
 * 本机 Ollama 管理（v2.4，CherryStudio 式体验的 CLI 版）。
 *
 * `memobox model enable` 的完整链路都在这：检测安装 → 确保 serve
 * 在跑（没跑就后台拉起，独立于 memobox 存活）→ 缺模型就流式拉取 →
 * 由调用方写配置 + 补算向量。
 *
 * fetch / 进程探测全部可注入，单测不碰真网络。
 */
export const OLLAMA_HOST = "http://localhost:11434";

/** 默认嵌入模型：bge-m3——多语（中英都好），约 1.2GB，中文场景首选 */
export const DEFAULT_EMBED_MODEL = "bge-m3";

/** 拉取进度的单条事件（Ollama /api/pull 的 NDJSON 行） */
export type PullStatus = {
  status: string;
  completed?: number;
  total?: number;
};

/** 探测 Ollama 服务是否在跑（500ms 短超时；fetch 可注入） */
export async function ollamaUp(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`${OLLAMA_HOST}/api/version`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** ollama 是否装在本机（PATH 上跑得通 --version）；返回版本号或 null */
export async function ollamaVersion(): Promise<string | null> {
  // Windows 下 Bun.spawn 找可执行不一定带 PATHEXT，两个名字都试
  for (const exe of ["ollama", "ollama.exe"]) {
    try {
      const proc = Bun.spawn([exe, "--version"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, code] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      if (code === 0) {
        const m = /(\d+(?:\.\d+)+)/.exec(out);
        return m ? m[1] : "unknown";
      }
    } catch {
      // 这个名字找不到就试下一个
    }
  }
  return null;
}

/** 已拉取的模型列表（api/tags 的 name 形如 "bge-m3:latest"——归一化去掉 tag）；服务没起返回 null */
export async function ollamaModels(fetchFn: typeof fetch = fetch): Promise<string[] | null> {
  try {
    const res = await fetchFn(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: { name?: string }[] };
    return (json.models ?? [])
      .map((m) => (m.name ?? "").split(":")[0])
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** 确保 Ollama 服务在跑：已在跑直接返回；否则后台 spawn `ollama serve` 并轮询端口 */
export async function ensureOllamaServer(fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (await ollamaUp(fetchFn)) return true; // 桌面版通常常驻，直接用
  if (!startOllamaServe()) return false;
  // 冷启动要几十毫秒到几秒；最多等 20 秒
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await ollamaUp(fetchFn)) return true;
  }
  return false;
}

/** 后台拉起 `ollama serve`（独立进程，memobox 退出后继续活着） */
function startOllamaServe(): boolean {
  for (const exe of ["ollama", "ollama.exe"]) {
    try {
      Bun.spawn({ cmd: [exe, "serve"], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      return true;
    } catch {
      // 这个名字找不到就试下一个
    }
  }
  return false;
}

/**
 * 拉取模型（流式）：POST /api/pull，逐行回调进度事件，
 * 收到 "success" 才算成功。中断 / 报错返回 false。
 */
export async function pullOllamaModel(
  name: string,
  onStatus: (s: PullStatus) => void,
  fetchFn: typeof fetch = fetch
): Promise<boolean> {
  let res: Response;
  try {
    res = await fetchFn(`${OLLAMA_HOST}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, stream: true }),
      // 1.2GB 的模型在慢网络下要等很久；10 分钟兜底
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch {
    return false;
  }
  if (!res.ok || !res.body) return false;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let ok = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const s = JSON.parse(line) as PullStatus;
        onStatus(s);
        if (s.status === "success") ok = true;
      } catch {
        // 坏行忽略（截断在多字节字符边界时可能偶发）
      }
    }
  }
  return ok;
}

/** 人类可读的进度行（拉取进度回调 → 单行文本） */
export function formatPullStatus(s: PullStatus): string {
  if (s.completed !== undefined && s.total) {
    const mb = (n: number) => `${(n / 1e6).toFixed(0)}MB`;
    return `${s.status}：${mb(s.completed)} / ${mb(s.total)}（${Math.round((s.completed / s.total) * 100)}%）`;
  }
  return s.status;
}
