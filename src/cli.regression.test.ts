import { describe, expect, test } from "bun:test";
import { runCli, VERSION, renderTable } from "./cli";
import { StubStore } from "./lib/memory-store";
import { SQLiteStore } from "./db/sqlite-store";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { tmpdir } from "node:os";

function output() {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

// 旧实现也可能进入模型分支；回归测试不能触碰真实模型或配置。
const noExternalTools = {
  probeOllama: async () => null, ollamaVersion: async () => null,
  ensureServer: async () => false, listModels: async () => null, pull: async () => false,
  loadLocalModel: async () => { throw Error("不应加载模型"); },
};

describe("CLI 2.6.2 参数回归", () => {
  test("--version 仅输出版本，不创建存储或进入 MCP", async () => {
    const h = output();
    let opened = 0;
    const code = await runCli(["--version"], h.io, () => { opened++; throw Error("不应建库"); }).catch(() => -1);
    expect(code).toBe(0);
    expect(h.out).toEqual([VERSION]);
    expect(h.err).toEqual([]);
    expect(opened).toBe(0);
  });

  for (const args of [
    ["save"], ["save", "   "], ["save", "文本", "--kind", "乱填"],
    ["list", "--limti", "1"], ["list", "--limit", "-1"], ["list", "--limit", "1.5"],
    ["search", "文本", "--limit"], ["search", "文本", "--limit", "abc"],
    ["query", "--since", "错日期"], ["model", "status", "--lite"],
    ["model", "enable", "--lite", "--model", "另一模型"], ["未知", "--help"],
    ["save", "文本", "--kind", "__proto__"], ["query", "--since", "2026-02-30"],
  ]) {
    test(`非法参数 ${args.join(" ")} 在任何操作前拒绝`, async () => {
      const h = output();
      let opened = 0;
      const code = await runCli(args, h.io, () => { opened++; throw Error("不应建库"); }, noExternalTools).catch(() => -1);
      expect(code).toBe(2);
      expect(opened).toBe(0);
      expect(h.err.join("\n")).toMatch(/[\u4e00-\u9fff]/);
      expect(h.out).toEqual([]);
    });
  }

  test("未知删除选项拒绝执行，记忆仍存在", async () => {
    const store = new StubStore();
    const saved = await store.save({ content: "删除回归" });
    const h = output();
    expect(await runCli(["forget", saved.id, "--dry-run"], h.io, () => store)).toBe(2);
    expect((await store.get(saved.id))?.content).toBe("删除回归");
  });

  test("布尔选项不吞文本，等号限制数量，-- 后文本可保存", async () => {
    const store = new StubStore();
    await store.save({ content: "开发端口 3100" });
    await store.save({ content: "无关内容" });
    const h = output();
    expect(await runCli(["query", "--json", "开发端口", "--limit=1"], h.io, () => store)).toBe(0);
    expect(JSON.parse(h.out.join("\n")).map((m: { content: string }) => m.content)).toEqual(["开发端口 3100"]);
    const saved = output();
    expect(await runCli(["save", "--", "--literal"], saved.io, () => store)).toBe(0);
    expect((await store.list(10)).some(m => m.content === "--literal")).toBe(true);
  });

  test("中文类型别名存为稳定枚举，嵌套帮助解释选项", async () => {
    const store = new StubStore(), h = output();
    expect(await runCli(["save", "类型测试", "--kind", "决策"], h.io, () => store)).toBe(0);
    expect((await store.list(1))[0].kind).toBe("decision");
    const help = output();
    expect(await runCli(["model", "enable", "--help"], help.io, () => store)).toBe(0);
    expect(help.out.join("\n")).toMatch(/^memobox model enable/);
    expect(help.out.join("\n")).toContain("--lite");
    expect(help.out.join("\n")).toContain("--model");
  });
});

describe("中文输出与错误回归", () => {
  test("doctor 显示真实配置来源、隐藏端点凭据并提示旧记录修复，不改动记忆", async () => {
    const root = mkdtempSync(join(tmpdir(), "memobox-doctor-"));
    const db = join(root, "旧 中文记忆.db"), config = join(root, "配置.json");
    const names = ["MEMOBOX_DB_PATH", "MEMOBOX_CONFIG_PATH", "EMBEDDING_API_BASE", "EMBEDDING_API_KEY"];
    const previous = names.map(name => process.env[name]);
    const store = new SQLiteStore(null, db);
    await store.save({ content: "应保留的旧库记录" });
    const raw = new Database(db);
    raw.exec("INSERT INTO memories(id,content,kind,source,entities,created_at,updated_at) VALUES ('legacy-blank','  ','fact','test','[]',1,1)");
    raw.close(true);
    const valid = await store.exportAll();
    try {
      writeFileSync(config, JSON.stringify({ embedding: { base: "https://config-user:config-password@example.invalid/v1?token=config-token", key: "config-key" } }));
      process.env.MEMOBOX_DB_PATH = db;
      process.env.MEMOBOX_CONFIG_PATH = config;
      delete process.env.EMBEDDING_API_BASE;
      delete process.env.EMBEDDING_API_KEY;
      for (const fromEnv of [false, true]) {
        if (fromEnv) process.env.EMBEDDING_API_BASE = "https://env-user:env-password@env.invalid/v1?token=env-token";
        const h = output();
        expect(await runCli(["doctor"], h.io, () => store, { ...noExternalTools, clientHome: root })).toBe(0);
        const text = h.out.join("\n");
        expect(text).toContain(db);
        expect(text).toContain(config);
        expect(text).toContain("模型配置来源：" + (fromEnv ? "环境变量 EMBEDDING_API_*" : "配置文件"));
        expect(text).toContain(fromEnv ? "https://env.invalid/v1" : "https://example.invalid/v1");
        expect(text).not.toMatch(/config-user|config-password|config-token|config-key|env-user|env-password|env-token/);
        expect(h.err.join("\n")).toContain("发现 1 条旧记忆");
        expect(h.err.join("\n")).toContain("不会自动清理");
      }
      expect(await store.exportAll()).toEqual(valid);
    } finally {
      store.close();
      names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("memobox-doctor-")) throw Error("诊断测试目录越界");
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("补算全部失败时返回非零退出码和中文失败计数", async () => {
    const store = new SQLiteStore({ model: "failed", dimensions: 2, async embed() { throw Error("模拟故障"); } }, ":memory:");
    try {
      await store.save({ content: "补算失败验收" });
      const h = output();
      expect(await runCli(["model", "reindex"], h.io, () => store, noExternalTools)).toBe(1);
      expect(h.err.join("\n")).toContain("失败 1");
      expect(h.out.join("\n")).toContain("已补算 0 条");
    } finally { store.close(); }
  });
  test("中文和 emoji 按终端列宽对齐，截断不切开字素", () => {
    const table = renderTable([{ content: "甲", source: "alpha" }, { content: "a", source: "beta" }]);
    const lines = table.split("\n");
    expect(Bun.stringWidth(lines[1].slice(0, lines[1].indexOf("alpha")))).toBe(Bun.stringWidth(lines[2].slice(0, lines[2].indexOf("beta"))));
    const cut = renderTable([{ content: "a".repeat(46) + "🙂xyz" }]);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const combined = renderTable([{ content: "e\u0301".repeat(60) }]).split("\n")[1];
    expect(Bun.stringWidth(combined)).toBeLessThanOrEqual(48);
  });

  test("人用表头/类型/实体中文，JSON 字段保持兼容", async () => {
    const store = new StubStore();
    await store.save({ content: "中文显示验收", kind: "decision", entities: ["中文项目"] });
    const h = output();
    expect(await runCli(["query"], h.io, () => store)).toBe(0);
    expect(h.out[0]).toContain("编号");
    expect(h.out[0]).toContain("决策");
    const search = output();
    await runCli(["search", "中文显示验收"], search.io, () => store);
    expect(search.out[0]).toContain("实体：");
    const raw = output();
    await runCli(["query", "--json"], raw.io, () => store);
    expect(JSON.parse(raw.out[0])[0].kind).toBe("decision");
  });

  test("文件异常默认中文，调试错误也不泄漏已配置的密钥", async () => {
    const previous = process.env.EMBEDDING_API_KEY;
    process.env.EMBEDDING_API_KEY = "regression-secret-value";
    try {
      for (const debug of [false, true]) {
        const h = output();
        const code = await runCli(["list", ...(debug ? ["--debug"] : [])], h.io, () => { throw Error("request failed: Bearer regression-secret-value"); });
        expect(code).toBe(1);
        expect(h.err.join("\n")).toMatch(/[\u4e00-\u9fff]/);
        expect(h.err.join("\n")).not.toContain("regression-secret-value");
        expect(h.out).toEqual([]);
      }
    } finally { if (previous === undefined) delete process.env.EMBEDDING_API_KEY; else process.env.EMBEDDING_API_KEY = previous; }
  });
});
