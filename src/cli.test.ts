import { describe, expect, test } from "bun:test";
import { parseArgs, runCli, VERSION } from "./cli";
import { StubStore } from "./lib/memory-store";
import type { MemoryStore } from "./lib/memory-store";

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
});
