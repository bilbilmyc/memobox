import type { CliIo } from "../cli";
import type { MemoryStore } from "../lib/memory-store";
import { probeOllama } from "../lib/embeddings";
import { createLocalEmbedder, isTransformersMissing, LOCAL_EMBED_MODEL } from "../lib/local-embedder";
import { defaultConfigPath, loadConfig, saveConfig } from "../lib/config";
import { DEFAULT_EMBED_MODEL, OLLAMA_HOST, ensureOllamaServer, formatPullStatus, ollamaModels, ollamaVersion, pullOllamaModel, type PullStatus } from "../lib/ollama";
import { safeEndpoint, formatCliError } from "./presentation";

/** doctor / model 子命令的外部依赖（真入口用默认值；单测注入假实现不碰网络） */
export type CliTools = {
  probeOllama: () => Promise<string | null>;
  ollamaVersion: () => Promise<string | null>;
  ensureServer: () => Promise<boolean>;
  listModels: () => Promise<string[] | null>;
  pull: (name: string, onStatus: (s: PullStatus) => void) => Promise<boolean>;
  /** 内置小模型预检：加载模型并 embed 一条自检文本（enable --lite 用） */
  loadLocalModel: (onProgress?: (msg: string) => void) => Promise<void>;
};

export const defaultCliTools: CliTools = {
  probeOllama,
  ollamaVersion,
  ensureServer: () => ensureOllamaServer(),
  listModels: () => ollamaModels(),
  pull: (name, onStatus) => pullOllamaModel(name, onStatus),
  loadLocalModel: async (onProgress) => {
    await createLocalEmbedder(onProgress).embed("memobox 启动自检");
  },
};


/** 三条模型写路径共用同一个补算报告，不遗漏失败退出状态。 */
async function backfill(store: MemoryStore, io: CliIo): Promise<number> {
  const report = await store.backfillEmbeddings((processed, total) => {
    if (processed % 10 === 0 || processed === total) io.out("  补算向量 " + processed + "/" + total);
  });
  io.out("已补算 " + report.succeeded + " 条记忆的向量；检查 " + report.inspected + " 条，需补算 " + report.needed + " 条，跳过 " + report.skipped + " 条");
  if (report.failed) {
    io.err("补算失败 " + report.failed + " 条；请检查模型或端点后运行 memobox model reindex 重试");
    return 1;
  }
  return 0;
}

export async function runModelCommand(
  pos: string[], flags: Map<string, string>, io: CliIo, makeStore: () => MemoryStore, tools: CliTools
): Promise<number> {
  // 本地嵌入模型管理（v2.4，CherryStudio 式）：
  // enable = 检测 Ollama → 没跑就拉起 serve → 缺模型就流式拉取 → 写配置 → 补算存量向量
  const sub = pos[1];
  if (sub === "reindex") {
    const store = makeStore();
    if (store.retrieval !== "semantic") {
      io.err("未启用语义检索——先配置嵌入端点，或运行 memobox model enable --lite");
      return 1;
    }
    return backfill(store, io);
  }
  if (sub === "status") {
    const ver = await tools.ollamaVersion();
    io.out(`本机 Ollama：${ver ? `已安装（${ver}）` : "未安装（https://ollama.com 下载）"}`);
    const models = ver ? await tools.listModels() : null;
    io.out(`Ollama 服务：${models ? `运行中（${models.length} 个模型${models.length ? "：" + models.join(", ") : ""}）` : "未运行"}`);
    const fromEnv = Boolean(process.env.EMBEDDING_API_BASE);
    const cfg = loadConfig().embedding;
    const mode = fromEnv
      ? "混合检索（来源：环境变量 EMBEDDING_API_*）"
      : cfg?.base
        ? `混合检索（来源：${defaultConfigPath()}，端点 ${safeEndpoint(cfg.base)}）`
        : cfg?.local
          ? `混合检索（来源：内置模型 ${cfg.model ?? LOCAL_EMBED_MODEL}，进程内推理）`
          : "关键词检索（memobox model enable --lite 可最轻启用语义检索）";
    io.out(`检索模式：  ${mode}`);
    return 0;
  }
  if (sub === "enable") {
    // --lite：内置小模型（v2.5 轻量方案）——不碰 Ollama，进程内推理
    if (flags.has("lite")) {
      io.out(`启用内置嵌入模型 ${LOCAL_EMBED_MODEL}（约 25MB，缓存在 ~/.memobox/models）…`);
      try {
        await tools.loadLocalModel((m) => io.out(`  ${m}`));
      } catch (e) {
        if (isTransformersMissing(e)) {
          // v2.6.1 起 npm 包默认不带 transformers（保持轻量）——按需补装
          io.err("内置模型依赖 @huggingface/transformers 未安装：");
          io.err("  npm 全局安装 memobox 的用户：npm i -g @huggingface/transformers");
          io.err("  源码仓库运行的用户：        bun add @huggingface/transformers");
          io.err("装好后重试：memobox model enable --lite");
          return 1;
        }
        io.err(formatCliError(e, "内置模型加载", flags.has("debug")));
        io.err("检查网络后重试（默认源 hf-mirror.com；可用环境变量 HF_ENDPOINT 换源）");
        return 1;
      }
      saveConfig({ ...loadConfig(), embedding: { local: true, model: LOCAL_EMBED_MODEL } });
      if (await backfill(makeStore(), io)) return 1;
      io.out(`✓ 语义检索已启用（内置模型，零外部服务）——写入 ${defaultConfigPath()}`);
      io.out(`  所有 memobox 进程（含 MCP 服务）下次启动自动生效，无需重装客户端`);
      return 0;
    }
    const model = flags.get("model") ?? DEFAULT_EMBED_MODEL;
    const ver = await tools.ollamaVersion();
    if (!ver) {
      io.err("未检测到 Ollama——先去 https://ollama.com 下载安装；或改用云端端点（.env.example 有示例）");
      return 1;
    }
    io.out(`Ollama 已安装（${ver}）`);
    if (!(await tools.ensureServer())) {
      io.err("Ollama 服务拉不起来——手动跑 `ollama serve` 后重试");
      return 1;
    }
    const models = await tools.listModels();
    if (models && !models.includes(model)) {
      io.out(`拉取模型 ${model}（首次约 1.2GB，取决于网速）…`);
      // 进度节流：状态词变化必打；纯下载进度每 +10% 打一行
      let lastStatus = "";
      let lastPct = -100;
      const ok = await tools.pull(model, (s) => {
        const pct = s.total ? Math.floor(((s.completed ?? 0) / s.total) * 100) : null;
        if (s.status !== lastStatus || (pct !== null && pct - lastPct >= 10)) {
          io.out(`  ${formatPullStatus(s)}`);
          lastStatus = s.status;
          if (pct !== null) lastPct = pct;
        }
      });
      if (!ok) {
        io.err("模型拉取失败（网络中断？）——重试 memobox model enable 会续传");
        return 1;
      }
    } else {
      io.out(`模型 ${model} 已就绪`);
    }
    // 先写配置再造 store——store 构造时读配置才能拿到刚启用的 embedder
    saveConfig({ ...loadConfig(), embedding: { base: `${OLLAMA_HOST}/v1`, model } });
    if (await backfill(makeStore(), io)) return 1;
    io.out(`✓ 语义检索已启用：${model} @ ${OLLAMA_HOST}/v1（写入 ${defaultConfigPath()}）`);
    io.out(`  所有 memobox 进程（含 MCP 服务）下次启动自动生效，无需重装客户端`);
    return 0;
  }
  if (sub === "disable") {
    if (process.env.EMBEDDING_API_BASE) {
      io.out("环境变量 EMBEDDING_API_BASE 还配着——它优先于配置文件；先从 shell / 客户端配置里删掉再 disable");
      return 0;
    }
    const cfg = loadConfig();
    if (!cfg.embedding) {
      io.out("本来就是关键词检索（没启用过语义模式）");
      return 0;
    }
    delete cfg.embedding;
    saveConfig(cfg);
    io.out("已停用语义检索，回到关键词模式（已算的向量留在库里不碍事；重启客户端生效）");
    return 0;
  }
  io.err("用法：memobox model <status|enable|disable|reindex> [--model 名]");
  return 1;
}
