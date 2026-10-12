import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteStore } from "./db/sqlite-store";
import { buildBackup } from "./lib/backup";
import { runCli } from "./cli";

test("恢复预览验证整份备份，区分新增、重复与冲突，不建库、不加载模型也不改旧库", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memobox-restore-preview-"));
  const dbPath = join(directory, "记忆.db"), file = join(directory, "备份.json"), previous = process.env.MEMOBOX_DB_PATH;
  const out: string[] = [], err: string[] = [], io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  const noStore = () => { throw Error("预览不能打开写连接或加载模型"); };
  process.env.MEMOBOX_DB_PATH = dbPath;
  try {
    const first = { id: "first", content: "当前端口 3100", kind: "decision", source: "mcp", entities: ["项目甲"], createdAt: 1 };
    writeFileSync(file, JSON.stringify(buildBackup([first, first])));
    expect(await runCli(["import", file, "--dry-run", "--json"], io, noStore)).toBe(0);
    expect(JSON.parse(out.pop()!)).toEqual({ total: 2, imported: 1, skipped: 1, conflicts: [], duplicateIds: ["first"] });
    expect(existsSync(dbPath)).toBe(false);
    const store = new SQLiteStore(null, dbPath);
    await store.importMemories([first]); store.close();
    const before = readFileSync(dbPath);
    const second = { id: "second", content: "新记忆", createdAt: 2 };
    writeFileSync(file, JSON.stringify(buildBackup([first, { ...first, content: "旧端口 3000" }, second, second])));
    expect(await runCli(["import", file, "--dry-run", "--json"], io, noStore)).toBe(0);
    expect(JSON.parse(out.pop()!)).toEqual({ total: 4, imported: 1, skipped: 3, conflicts: ["first"], duplicateIds: ["first", "second"] });
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    const after = new SQLiteStore(null, dbPath);
    try {
      expect(await after.exportAll()).toEqual([first]);
      expect(await runCli(["import", file], io, () => after)).toBe(0);
      expect((await after.stats()).total).toBe(2);
      expect((await after.get("first"))?.content).toBe(first.content);
    } finally { after.close(); }
    writeFileSync(file, JSON.stringify({ ...buildBackup([first]), version: 99 }));
    expect(await runCli(["import", file, "--dry-run"], io, noStore)).toBe(1);
    expect(err.join("\n")).toContain("不支持的备份版本");
  } finally {
    if (previous === undefined) delete process.env.MEMOBOX_DB_PATH; else process.env.MEMOBOX_DB_PATH = previous;
    if (resolve(directory).startsWith(resolve(tmpdir()) + "/") || resolve(directory).startsWith(resolve(tmpdir()) + "\\")) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
