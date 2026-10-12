import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdHelp, parseArgs, parseSince, renderTable, runCli, USAGE, VERSION } from "./cli";
import { StubStore } from "./lib/memory-store";
import { loadConfig, saveConfig } from "./lib/config";
import type { Memory, MemoryStore } from "./lib/memory-store";
import { SQLiteStore } from "./db/sqlite-store";

/** 收集输出的假 io + 新 StubStore——runCli 全注入，不起真进程 */
function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const store = () => new StubStore() as MemoryStore;
  const io = {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
  };
  return { out, err, store, io, text: () => out.join("\n") };
}

/** doctor / model 测试用的「没有 Ollama」假工具集（不碰真网络/进程） */
const noOllamaTools = () => ({
  probeOllama: async () => null,
  ollamaVersion: async () => null,
  ensureServer: async () => false,
  listModels: async () => null,
  pull: async () => false,
  loadLocalModel: async () => {},
});

/** 把配置文件指向不存在的临时路径并删掉 env 干扰；返回还原函数 */
function isolateConfig(): () => void {
  const prevBase = process.env.EMBEDDING_API_BASE;
  const prevCfg = process.env.MEMOBOX_CONFIG_PATH;
  delete process.env.EMBEDDING_API_BASE;
  process.env.MEMOBOX_CONFIG_PATH = join(tmpdir(), "memobox-test-no-config.json");
  return () => {
    if (prevBase !== undefined) process.env.EMBEDDING_API_BASE = prevBase;
    if (prevCfg !== undefined) process.env.MEMOBOX_CONFIG_PATH = prevCfg;
    else delete process.env.MEMOBOX_CONFIG_PATH;
  };
}

/** 造几条带显式 createdAt 的记忆（时间过滤的确定性靠它） */
const DAY = 864e5;
function planted(): StubStore {
  const s = new StubStore();
  const now = Date.now();
  void s.importMemories([
    { id: "old-port", content: "prefer port 3100", kind: "preference", entities: ["ports"], source: "codex", createdAt: now - 30 * DAY },
    { id: "new-tab", content: "this repo uses tabs", kind: "preference", entities: ["style"], source: "claude", createdAt: now - DAY },
    { id: "new-dec", content: "switched to bun runtime", kind: "decision", entities: ["memobox"], source: "codex", createdAt: now },
  ]);
  return s;
}

describe("parseArgs", () => {
  test("位置参数与 --flag 值分开收集", () => {
    const { pos, flags } = parseArgs([
      "save", "hello", "world", "--kind", "fact", "--entities", "a,b",
    ]);
    expect(pos).toEqual(["save", "hello", "world"]);
    expect(flags.get("kind")).toBe("fact");
    expect(flags.get("entities")).toBe("a,b");
  });

  test("末尾孤旗标按布尔收集（--json / --help）", () => {
    const { flags } = parseArgs(["query", "--json"]);
    expect(flags.has("json")).toBe(true);
  });
});

describe("帮助体系（v2.3）", () => {
  test("总帮助列出全部命令与描述", async () => {
    const h = harness();
    expect(await runCli(["help"], h.io, h.store)).toBe(0);
    const text = h.text();
    for (const name of ["serve", "save", "search", "query", "sql", "import-codex", "install"]) {
      expect(text).toContain(name);
    }
  });

  test("help <命令> 给单条用法；未知命令报错", async () => {
    const h = harness();
    await runCli(["help", "save"], h.io, h.store);
    expect(h.text()).toContain("memobox save <文本>");
    expect(h.text()).not.toContain("memobox sql");

    const h2 = harness();
    expect(await runCli(["help", "nope"], h2.io, h2.store)).toBe(2);
    expect(h2.err[0]).toContain("未知命令");
  });

  test("任意命令跟 --help 输出该命令帮助", async () => {
    const h = harness();
    await runCli(["sql", "--help"], h.io, h.store);
    expect(h.text()).toContain("只读 SQL");
    const h2 = harness();
    await runCli(["--help"], h2.io, h2.store);
    expect(h2.text()).toContain("memobox <命令>");
  });

  test("cmdHelp 对每个注册命令都有内容，USAGE 含版本", () => {
    for (const name of ["serve", "save", "query", "import-codex"]) {
      expect(cmdHelp(name)).toBeTruthy();
    }
    expect(cmdHelp("does-not-exist")).toBeNull();
    expect(USAGE).toContain(VERSION);
  });
});

describe("runCli 基础命令", () => {
  test("save → search 闭环", async () => {
    const h = harness();
    const shared = new StubStore();
    const mk = () => shared as MemoryStore;
    expect(await runCli(["save", "prefer", "port", "3100", "--entities", "ports"], h.io, mk)).toBe(0);
    expect(h.out[0]).toMatch(/^已保存记忆 \S+$/);
    h.out.length = 0;
    await runCli(["search", "port"], h.io, mk);
    expect(h.text()).toContain("prefer port 3100");
  });

  test("save 缺内容 / search 空结果 / list 空库的中文提示", async () => {
    const h = harness();
    expect(await runCli(["save"], h.io, h.store)).toBe(2);
    expect(h.err[0]).toContain("用法");

    const h2 = harness();
    await runCli(["search", "zzz"], h2.io, h2.store);
    expect(h2.text()).toContain("没有匹配的记忆");

    const h3 = harness();
    await runCli(["list"], h3.io, h3.store);
    expect(h3.text()).toContain("还没有记忆");
  });

  test("forget 找不到 → 报错退出 1", async () => {
    const h = harness();
    expect(await runCli(["forget", "nope"], h.io, h.store)).toBe(1);
    expect(h.err[0]).toContain("未找到");
  });

  test("stats / version / 未知命令", async () => {
    const h = harness();
    await runCli(["stats"], h.io, h.store);
    expect(h.text()).toMatch(/共 0 条记忆，0 次检索/);

    const h1 = harness();
    await runCli(["version"], h1.io, h1.store);
    expect(h1.out[0]).toBe(VERSION);

    const h2 = harness();
    expect(await runCli(["frobnicate"], h2.io, h2.store)).toBe(2);
    expect(h2.err[0]).toContain("未知命令");
  });

  test("install 子命令参数校验", async () => {
    const h = harness();
    expect(await runCli(["install", "vscode"], h.io, h.store)).toBe(2);
    expect(h.err[0]).toContain("claude|codex|pi");
  });

  test("install 无参数：打印任意客户端的通用接法", async () => {
    const h = harness();
    expect(await runCli(["install"], h.io, h.store)).toBe(0);
    const text = h.text();
    expect(text).toContain("command:");
    expect(text).toContain("args:");
    expect(text).toContain("一键接入");
  });

  test("doctor 输出库/检索模式/三家客户端状态", async () => {
    const h = harness();
    // 注入「没探测到 Ollama」+ 隔离配置文件，保持输出确定（否则要碰网络/真配置）
    const restore = isolateConfig();
    try {
      expect(await runCli(["doctor"], h.io, h.store, noOllamaTools())).toBe(0);
      const text = h.text();
      expect(text).toContain("库文件：");
      expect(text).toContain("检索模式：");
      for (const c of ["codex:", "pi:", "claude:"]) expect(text).toContain(c);
      expect(text).not.toContain("Ollama");
    } finally {
      restore();
    }
  });

  test("doctor：keyword 模式探测到本机 Ollama 时给一键升级提示", async () => {
    const h = harness();
    const restore = isolateConfig();
    try {
      await runCli(["doctor"], h.io, h.store, { ...noOllamaTools(), probeOllama: async () => "bge-m3" });
      const text = h.text();
      expect(text).toContain("检测到本机 Ollama");
      expect(text).toContain("memobox model enable");
    } finally {
      restore();
    }
  });

  test("doctor：装了 Ollama 但服务没跑 → 提示 enable 会拉起", async () => {
    const h = harness();
    const restore = isolateConfig();
    try {
      await runCli(["doctor"], h.io, h.store, { ...noOllamaTools(), ollamaVersion: async () => "0.5.7" });
      expect(h.text()).toContain("服务未运行");
    } finally {
      restore();
    }
  });
});

describe("query / get / sql", () => {
  test("query：文本 + kind + entity + since 过滤（AND）", async () => {
    const s = planted();
    const mk = () => s as MemoryStore;
    const run = async (args: string[]) => {
      const out: string[] = [];
      await runCli(args, { out: (x) => out.push(x), err: () => {} }, mk);
      return out.join("\n");
    };
    expect(await run(["query", "port"])).toContain("old-port");
    expect(await run(["query", "port"])).not.toContain("new-tab");
    expect(await run(["query", "--kind", "decision"])).toContain("new-dec");
    expect(await run(["query", "--entity", "PORTS"])).toContain("old-port");
    const recent = await run(["query", "--since", "7d"]);
    expect(recent).toContain("new-tab");
    expect(recent).not.toContain("old-port");
    expect(await run(["query", "不存在的词xyz"])).toBe("(无结果)");
  });

  test("query --json 输出 JSON 数组；--since 非法报错", async () => {
    const s = planted();
    const out: string[] = [];
    await runCli(["query", "--kind", "decision", "--json"], { out: (x) => out.push(x), err: () => {} }, () => s as MemoryStore);
    const parsed = JSON.parse(out.join("\n")) as Memory[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("new-dec");

    const h = harness();
    expect(await runCli(["query", "--since", "last week"], h.io, h.store)).toBe(2);
    expect(h.err[0]).toContain("--since");
  });

  test("get：命中输出 JSON / 未命中报错", async () => {
    const s = planted();
    const out: string[] = [];
    const err: string[] = [];
    await runCli(["get", "new-dec"], { out: (x) => out.push(x), err: (x) => err.push(x) }, () => s as MemoryStore);
    expect(JSON.parse(out.join("\n")).content).toBe("switched to bun runtime");
    expect(await runCli(["get", "nope"], { out: () => {}, err: (x) => err.push(x) }, () => s as MemoryStore)).toBe(1);
  });

  test("sql：非 SELECT 拒绝；对真实 SQLite 文件只读查询", async () => {
    const h = harness();
    expect(await runCli(["sql", "DELETE FROM memories"], h.io, h.store)).toBe(1);
    expect(h.err[0]).toContain("只读模式");

    const { SQLiteStore } = await import("./db/sqlite-store");
    const prev = process.env.MEMOBOX_DB_PATH;
    const tmp = join(mkdtempSync(join(tmpdir(), "memobox-sql-")), "m.db");
    process.env.MEMOBOX_DB_PATH = tmp;
    try {
      const store = new SQLiteStore(null, tmp);
      await store.save({ content: "sql probe row", entities: ["sql"], source: "test" });
      const out: string[] = [];
      await runCli(
        ["sql", "SELECT source, count(*) AS n FROM memories GROUP BY source"],
        { out: (x) => out.push(x), err: () => {} },
        () => new StubStore() as MemoryStore
      );
      expect(out.join("\n")).toContain("test");
      const j: string[] = [];
      await runCli(
        ["sql", "SELECT content FROM memories", "--json"],
        { out: (x) => j.push(x), err: () => {} },
        () => new StubStore() as MemoryStore
      );
      expect(JSON.parse(j.join("\n"))[0].content).toBe("sql probe row");
    } finally {
      if (prev === undefined) delete process.env.MEMOBOX_DB_PATH;
      else process.env.MEMOBOX_DB_PATH = prev;
    }
  });
});

describe("import-codex（v2.3）", () => {
  const FIXTURE = `# Task Group: Java environment setup

scope: Install and verify the Windows Java toolchain.
applies_to: cwd=D:\\workspace\\Java

## Task 1: Install Temurin JDK 21, success

### rollout_summary_files

- rollout_summaries/2026-10-10T14-08-34-x.md (cwd=x, success)

### keywords

- Temurin, OpenJDK, JAVA_HOME, JAVA_ENV_OK

## Task 2: Configure Gradle cache, partial

### keywords

- Gradle, GRADLE_USER_HOME

# Task Group: Web product

## Task 3: Ship landing page, uncertain

### keywords

- Next.js
`;

  function fixtureHome() {
    const home = mkdtempSync(join(tmpdir(), "memobox-imp-"));
    mkdirSync(join(home, ".codex", "memories"), { recursive: true });
    writeFileSync(join(home, ".codex", "memories", "MEMORY.md"), FIXTURE, "utf-8");
    writeFileSync(
      join(home, ".codex", "memories", "memory_summary.md"),
      "## User Profile\n\nChinese-speaking builder, values verified outcomes.\n\n## User preferences\n\n- x\n",
      "utf-8"
    );
    return home;
  }

  test("解析 MEMORY.md + 用户画像，dry-run 预览不落库", async () => {
    const home = fixtureHome();
    const s = new StubStore();
    const out: string[] = [];
    const code = await runCli(
      ["import-codex", "--file", join(home, ".codex", "memories", "MEMORY.md"), "--dry-run"],
      { out: (x) => out.push(x), err: () => {} },
      () => s as MemoryStore
    );
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("[试运行]");
    expect(text).toContain("Install Temurin JDK 21");
    // dry-run 不落库（画像也未写入：同目录 summary 只在真导入时带）
    expect(await s.stats()).toEqual({ total: 0, searches: 0 });
  });

  test("真导入：3 任务 + 1 画像，id 幂等", async () => {
    const home = fixtureHome();
    const s = new StubStore();
    const mk = () => s as MemoryStore;
    const out: string[] = [];
    await runCli(
      ["import-codex", "--file", join(home, ".codex", "memories", "MEMORY.md")],
      { out: (x) => out.push(x), err: () => {} },
      mk
    );
    expect(out[0]).toContain("新增 4");
    const rows = await s.list(10);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("codex-user-profile");
    expect(rows.filter((r) => r.id.startsWith("codex-"))).toHaveLength(4);
    // keywords 进了 entities
    const jdk = rows.find((r) => r.content.includes("Temurin"))!;
    expect(jdk.entities).toContain("JAVA_HOME");
    // 状态尾缀保留在内容里
    expect(jdk.content).toContain("[success]");
    // 再导一遍：全跳过
    const out2: string[] = [];
    await runCli(
      ["import-codex", "--file", join(home, ".codex", "memories", "MEMORY.md")],
      { out: (x) => out2.push(x), err: () => {} },
      mk
    );
    expect(out2[0]).toContain("新增 0");
    expect(out2[0]).toContain("跳过 4");
  });

  test("缺文件报错", async () => {
    const h = harness();
    expect(
      await runCli(["import-codex", "--file", "Z:/nope/MEMORY.md"], h.io, h.store)
    ).toBe(1);
    expect(h.err[0]).toContain("找不到");
  });
});

describe("model 子命令（v2.4，本地小模型管理）", () => {
  const CFG = join(tmpdir(), "memobox-model-test-config.json");

  /** 指向临时配置文件 + 清掉 env 干扰；返回还原函数 */
  function setup(): () => void {
    const restore = isolateConfig();
    process.env.MEMOBOX_CONFIG_PATH = CFG;
    rmSync(CFG, { force: true });
    return restore;
  }

  test("缺子命令 / 未知子命令报用法", async () => {
    const restore = setup();
    try {
      const h = harness();
      expect(await runCli(["model"], h.io, h.store, noOllamaTools())).toBe(2);
      expect(h.err[0]).toContain("status|enable|disable");
      expect(await runCli(["model", "frob"], h.io, h.store, noOllamaTools())).toBe(2);
    } finally {
      restore();
    }
  });

  test("reindex 使用当前存储配置，保留匹配的向量，不启动 Ollama 或改配置", async () => {
    const restore = setup();
    const store = new SQLiteStore({ model: "reindex-test", dimensions: 2, async embed() { return [1, 0]; } }, ":memory:");
    try {
      await store.save({ content: "alpha" });
      const h = harness();
      expect(await runCli(["model", "reindex"], h.io, () => store, noOllamaTools())).toBe(0);
      expect(h.text()).toContain("已补算 0 条");
      expect(existsSync(CFG)).toBe(false);
      const disabled = harness();
      expect(await runCli(["model", "reindex"], disabled.io, disabled.store, noOllamaTools())).toBe(1);
      expect(disabled.err[0]).toContain("未启用语义检索");
    } finally { store.close(); restore(); }
  });

  test("enable 全链路：装好→起服务→拉模型→写配置（桩库补算 0）", async () => {
    const restore = setup();
    try {
      const pulled: string[] = [];
      const tools = {
        ...noOllamaTools(),
        ollamaVersion: async () => "0.5.7",
        ensureServer: async () => true,
        listModels: async () => [],
        pull: async (
          name: string,
          onStatus: (s: { status: string; completed?: number; total?: number }) => void
        ) => {
          pulled.push(name);
          onStatus({ status: "pulling manifest" });
          onStatus({ status: "success" });
          return true;
        },
      };
      const h = harness();
      expect(await runCli(["model", "enable"], h.io, h.store, tools)).toBe(0);
      const text = h.text();
      expect(pulled).toEqual(["bge-m3"]);
      expect(text).toContain("拉取模型 bge-m3");
      expect(text).toContain("语义检索已启用");
      expect(text).toContain("自动生效");
      expect(JSON.parse(readFileSync(CFG, "utf-8"))).toEqual({
        embedding: { base: "http://localhost:11434/v1", model: "bge-m3" },
      });
    } finally {
      restore();
    }
  });

  test("enable：模型已在库时跳过拉取；--model 可换默认", async () => {
    const restore = setup();
    try {
      const pulled: string[] = [];
      const tools = {
        ...noOllamaTools(),
        ollamaVersion: async () => "0.5.7",
        ensureServer: async () => true,
        listModels: async () => ["bge-m3"],
        pull: async (name: string) => {
          pulled.push(name);
          return true;
        },
      };
      const h = harness();
      expect(await runCli(["model", "enable", "--model", "all-minilm"], h.io, h.store, tools)).toBe(0);
      expect(pulled).toEqual(["all-minilm"]);
      expect(h.text()).toContain("all-minilm");
      expect(loadConfig(CFG).embedding?.model).toBe("all-minilm");
    } finally {
      restore();
    }
  });

  test("enable：没装 Ollama 报错且不写配置", async () => {
    const restore = setup();
    try {
      const h = harness();
      expect(await runCli(["model", "enable"], h.io, h.store, noOllamaTools())).toBe(1);
      expect(h.err[0]).toContain("未检测到 Ollama");
      expect(existsSync(CFG)).toBe(false);
    } finally {
      restore();
    }
  });

  test("disable：删配置段回到关键词；没启用过时明说", async () => {
    const restore = setup();
    try {
      saveConfig({ embedding: { base: "http://x/v1", model: "m" } }, CFG);
      const h = harness();
      expect(await runCli(["model", "disable"], h.io, h.store, noOllamaTools())).toBe(0);
      expect(h.text()).toContain("已停用");
      expect(loadConfig(CFG)).toEqual({});
      const h2 = harness();
      await runCli(["model", "disable"], h2.io, h2.store, noOllamaTools());
      expect(h2.text()).toContain("本来就是");
    } finally {
      restore();
    }
  });

  test("status：安装/服务/检索模式与配置来源", async () => {
    const restore = setup();
    try {
      const tools = {
        ...noOllamaTools(),
        ollamaVersion: async () => "0.5.7",
        listModels: async () => ["bge-m3", "llama3.2"],
      };
      const h = harness();
      expect(await runCli(["model", "status"], h.io, h.store, tools)).toBe(0);
      const text = h.text();
      expect(text).toContain("已安装（0.5.7）");
      expect(text).toContain("运行中（2 个模型");
      expect(text).toContain("关键词检索");
      // 配置文件启用后显示 semantic + 来源
      saveConfig({ embedding: { base: "http://localhost:11434/v1", model: "bge-m3" } }, CFG);
      const h2 = harness();
      await runCli(["model", "status"], h2.io, h2.store, tools);
      expect(h2.text()).toContain("混合检索");
      expect(h2.text()).toContain("来源");
    } finally {
      restore();
    }
  });

  test("enable --lite：预检通过写 local 配置；预检失败不写", async () => {
    const restore = setup();
    try {
      const h = harness();
      expect(await runCli(["model", "enable", "--lite"], h.io, h.store, noOllamaTools())).toBe(0);
      const text = h.text();
      expect(text).toContain("内置嵌入模型");
      expect(text).toContain("零外部服务");
      expect(loadConfig(CFG)).toEqual({
        embedding: { local: true, model: "Xenova/bge-small-zh-v1.5" },
      });

      rmSync(CFG, { force: true });
      const fail = {
        ...noOllamaTools(),
        loadLocalModel: async () => {
          throw new Error("network down");
        },
      };
      const h2 = harness();
      expect(await runCli(["model", "enable", "--lite"], h2.io, h2.store, fail)).toBe(1);
      expect(h2.err[0]).toContain("加载失败");
      expect(existsSync(CFG)).toBe(false);

      // v2.6.1：npm 版不带 transformers——缺包给专属安装指引，不写配置
      rmSync(CFG, { force: true });
      const missing = {
        ...noOllamaTools(),
        loadLocalModel: async () => {
          throw new Error(
            "Cannot find package '@huggingface/transformers' from 'D:\\memobox\\src\\lib\\local-embedder.ts'"
          );
        },
      };
      const h3 = harness();
      expect(await runCli(["model", "enable", "--lite"], h3.io, h3.store, missing)).toBe(1);
      expect(h3.err[0]).toContain("未安装");
      expect(h3.err.some((l) => l.includes("npm i -g @huggingface/transformers"))).toBe(true);
      expect(existsSync(CFG)).toBe(false);
    } finally {
      restore();
    }
  });

  test("status：local 模式显示内置模型来源", async () => {
    const restore = setup();
    try {
      saveConfig({ embedding: { local: true, model: "Xenova/bge-small-zh-v1.5" } }, CFG);
      const h = harness();
      expect(await runCli(["model", "status"], h.io, h.store, noOllamaTools())).toBe(0);
      expect(h.text()).toContain("内置模型 Xenova/bge-small-zh-v1.5");
    } finally {
      restore();
    }
  });
});

describe("纯工具函数", () => {
  test("parseSince：相对时长 / ISO / 非法", () => {
    const now = Date.now();
    expect(parseSince("1d")).toBeGreaterThan(now - 864e5 - 1000);
    expect(parseSince("1d")).toBeLessThanOrEqual(now - 864e5 + 1000);
    expect(parseSince("2026-01-01")).toBe(Date.parse("2026-01-01"));
    expect(Number.isNaN(parseSince("someday"))).toBe(true);
  });

  test("renderTable：表头对齐 + 截断 + 空表", () => {
    expect(renderTable([])).toBe("(无结果)");
    const text = renderTable([{ id: "a", content: "x".repeat(80) }]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("id");
    expect(lines[1]).toContain("…");
  });
});
