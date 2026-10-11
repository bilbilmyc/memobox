import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, parseSince, renderTable, runCli, VERSION } from "./cli";
import { StubStore } from "./lib/memory-store";
import type { Memory, MemoryStore } from "./lib/memory-store";

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

describe("parseArgs", () => {
  test("位置参数与 --flag 值分开收集", () => {
    const { pos, flags } = parseArgs([
      "save",
      "hello",
      "world",
      "--kind",
      "fact",
      "--entities",
      "a,b",
    ]);
    expect(pos).toEqual(["save", "hello", "world"]);
    expect(flags.get("kind")).toBe("fact");
    expect(flags.get("entities")).toBe("a,b");
  });
});

describe("runCli", () => {
  test("save → search 闭环（kind/entities 解析）", async () => {
    const h = harness();
    expect(await runCli(["save", "memobox", "uses", "port", "3100", "--entities", "memobox,ports"], h.io, h.store)).toBe(0);
    expect(h.out[0]).toMatch(/^saved memory \S+$/);

    const h2 = harness();
    // save 和 search 要共享一个 store 才闭环——工厂里闭包同一个实例
    const shared = new StubStore();
    const mk = () => shared as MemoryStore;
    await runCli(["save", "prefer port 3100", "--entities", "ports"], h2.io, mk);
    h2.out.length = 0;
    await runCli(["search", "port"], h2.io, mk);
    expect(h2.text()).toContain("prefer port 3100");
  });

  test("save 缺内容 → 用法报错 + 退出码 1", async () => {
    const h = harness();
    expect(await runCli(["save"], h.io, h.store)).toBe(1);
    expect(h.err[0]).toContain("usage");
  });

  test("list 空库给引导文案", async () => {
    const h = harness();
    await runCli(["list"], h.io, h.store);
    expect(h.text()).toContain("no memories yet");
  });

  test("forget 找不到 → 报错退出 1", async () => {
    const h = harness();
    expect(await runCli(["forget", "nope"], h.io, h.store)).toBe(1);
    expect(h.err[0]).toContain("not found");
  });

  test("stats", async () => {
    const h = harness();
    await runCli(["stats"], h.io, h.store);
    expect(h.text()).toMatch(/0 memories, 0 searches/);
  });

  test("version / help / 未知命令", async () => {
    const h1 = harness();
    await runCli(["version"], h1.io, h1.store);
    expect(h1.out[0]).toBe(VERSION);

    const h2 = harness();
    await runCli(["help"], h2.io, h2.store);
    expect(h2.text()).toContain("memobox install");

    const h3 = harness();
    expect(await runCli(["frobnicate"], h3.io, h3.store)).toBe(1);
    expect(h3.err[0]).toContain("unknown command");
  });

  test("install 子命令参数校验", async () => {
    const h = harness();
    expect(await runCli(["install", "vscode"], h.io, h.store)).toBe(1);
    expect(h.err[0]).toContain("claude|codex|pi");
  });

  test("doctor 输出库/检索模式/三家客户端状态", async () => {
    const h = harness();
    expect(await runCli(["doctor"], h.io, h.store)).toBe(0);
    const text = h.text();
    expect(text).toContain("db:");
    expect(text).toContain("retrieval:");
    for (const c of ["codex:", "pi:", "claude:"]) expect(text).toContain(c);
  });

  test("query：文本 + kind + entity + since 过滤（AND）", async () => {
    const s = planted();
    const mk = () => s as MemoryStore;
    const run = async (args: string[]) => {
      const out: string[] = [];
      await runCli(args, { out: (x) => out.push(x), err: () => {} }, mk);
      return out.join("\n");
    };
    // 文本子串
    expect(await run(["query", "port"])).toContain("old-port");
    expect(await run(["query", "port"])).not.toContain("new-tab");
    // kind
    expect(await run(["query", "--kind", "decision"])).toContain("new-dec");
    expect(await run(["query", "--kind", "decision"])).not.toContain("new-tab");
    // entity 大小写不敏感
    expect(await run(["query", "--entity", "PORTS"])).toContain("old-port");
    // since 排掉 30 天前的
    const recent = await run(["query", "--since", "7d"]);
    expect(recent).toContain("new-tab");
    expect(recent).not.toContain("old-port");
    // 组合
    const combo = await run(["query", "--source", "codex", "--kind", "decision"]);
    expect(combo).toContain("new-dec");
    expect(combo).not.toContain("old-port");
    // 空结果
    expect(await run(["query", "不存在的词xyz"])).toBe("(no rows)");
  });

  test("query --json 输出 JSON 数组", async () => {
    const s = planted();
    const out: string[] = [];
    await runCli(["query", "--kind", "decision", "--json"], { out: (x) => out.push(x), err: () => {} }, () => s as MemoryStore);
    const parsed = JSON.parse(out.join("\n")) as Memory[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("new-dec");
  });

  test("query --since 格式非法报错退出 1", async () => {
    const h = harness();
    expect(await runCli(["query", "--since", "last week"], h.io, h.store)).toBe(1);
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
});

describe("sql 子命令", () => {
  test("非 SELECT 语句直接拒绝", async () => {
    const h = harness();
    expect(await runCli(["sql", "DELETE FROM memories"], h.io, h.store)).toBe(1);
    expect(h.err[0]).toContain("read-only");
  });

  test("对真实 SQLite 文件的只读 SELECT", async () => {
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
      const text = out.join("\n");
      expect(text).toContain("source");
      expect(text).toContain("test");
      // --json 通道
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

describe("纯工具函数", () => {
  test("parseSince：相对时长 / ISO / 非法", () => {
    const now = Date.now();
    expect(parseSince("1d")).toBeGreaterThan(now - 864e5 - 1000);
    expect(parseSince("1d")).toBeLessThanOrEqual(now - 864e5 + 1000);
    expect(parseSince("2026-01-01")).toBe(Date.parse("2026-01-01"));
    expect(Number.isNaN(parseSince("someday"))).toBe(true);
  });

  test("renderTable：表头对齐 + 截断 + 空表", () => {
    expect(renderTable([])).toBe("(no rows)");
    const text = renderTable([{ id: "a", content: "x".repeat(80) }]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("id");
    expect(lines[1]).toContain("…");
  });
});
