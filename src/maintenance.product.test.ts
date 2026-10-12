import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { SQLiteStore } from "./db/sqlite-store";
import { parseBackup } from "./lib/backup";
import { Database } from "bun:sqlite";
import { runCli } from "./cli";
import { handleRpcBody } from "./lib/mcp";

test("批量维护先预览，未确认和过期快照不改记忆，确认后先备份并原子执行", async () => {
  const root = mkdtempSync(join(tmpdir(), "memobox-maintenance-")), path = join(root, "memory.db");
  const a = new SQLiteStore(null, path), b = new SQLiteStore(null, path);
  try {
    await a.importMemories([
      { id: "primary", content: "端口 3100", kind: "decision", entities: ["项目甲"], source: "agent-a", createdAt: 1 },
      { id: "duplicate", content: "端口 3100", kind: "decision", entities: ["项目甲"], source: "agent-b", createdAt: 2 },
      { id: "conflict", content: "端口 3000", kind: "decision", entities: ["项目甲"], source: "agent-b", createdAt: 3 },
    ]);
    const suggestions = await a.scanMaintenance({ before: 3 });
    expect(suggestions.duplicates[0].ids).toEqual(["duplicate", "primary"]);
    expect(suggestions.conflicts[0].ids).toContain("conflict");
    expect(suggestions.older).toEqual(["primary", "duplicate"]);
    const plan = await a.planMaintenance({ ids: ["primary", "duplicate"], replacement: { content: "合并确认：开发端口 3100" } });
    expect((await a.stats()).total).toBe(3);
    await expect(a.applyMaintenance(plan, { confirm: false, backupDirectory: root })).rejects.toThrow();
    await b.update("duplicate", { content: "外部修订，不应被旧计划覆盖" });
    await expect(a.applyMaintenance(plan, { confirm: true, backupDirectory: root })).rejects.toThrow();
    expect((await a.get("primary"))?.content).toBe("端口 3100");
    const fresh = await a.planMaintenance({ ids: ["primary", "duplicate"], replacement: { content: "合并确认：开发端口 3100" } });
    const result = await a.applyMaintenance(fresh, { confirm: true, backupDirectory: root });
    expect(result).toMatchObject({ deleted: 1, updated: "primary" });
    const backup = parseBackup(readFileSync(result.backup, "utf8"));
    expect(backup.ok).toBe(true);
    if (backup.ok) expect(backup.items.map(m => m.content)).toEqual(["端口 3100", "外部修订，不应被旧计划覆盖"]);
    expect((await b.get("primary"))?.createdAt).toBe(1);
    expect((await b.search("合并确认"))[0].id).toBe("primary");
    expect(await b.get("duplicate")).toBeNull();
    expect(await b.get("conflict")).not.toBeNull();
    if (!backup.ok) throw Error("备份校验失败");
    await expect(a.restoreMemories(backup.items, { confirm: false, backupDirectory: root })).rejects.toThrow();
    const restored = await a.restoreMemories(backup.items, { confirm: true, backupDirectory: root });
    expect(restored).toMatchObject({ imported: 1, replaced: 1 });
    expect((await b.get("primary"))?.content).toBe("端口 3100");
    expect((await b.get("duplicate"))?.createdAt).toBe(2);
    const undo = parseBackup(readFileSync(restored.backup, "utf8"));
    expect(undo.ok && undo.items[0].content).toBe("合并确认：开发端口 3100");
    await b.forget("duplicate");
    const removal = await b.planMaintenance({ ids: ["conflict"] });
    expect((await b.applyMaintenance(removal, { confirm: true, backupDirectory: root })).deleted).toBe(1);
    expect((await a.stats()).total).toBe(1);
  } finally {
    a.close(); b.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("memobox-maintenance-")) throw Error("清理路径越界");
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});

test("备份失败或删除触发器失败不产生部分合并，CLI/MCP 必须明确确认", async () => {
  const root = mkdtempSync(join(tmpdir(), "memobox-maintenance-fault-")), path = join(root, "memory.db");
  const store = new SQLiteStore(null, path), out: string[] = [], io = { out: (s: string) => out.push(s), err: () => {} };
  try {
    await store.importMemories([{ id: "a", content: "原文 a", createdAt: 1 }, { id: "b", content: "原文 b", createdAt: 2 }]);
    const original = await store.exportAll(), plan = await store.planMaintenance({ ids: ["a", "b"], replacement: { content: "摘要" } });
    const occupied = join(root, "file-not-directory"); writeFileSync(occupied, "fixture");
    await expect(store.applyMaintenance(plan, { confirm: true, backupDirectory: occupied })).rejects.toThrow();
    expect(await store.exportAll()).toEqual(original);
    const raw = new Database(path); raw.exec("CREATE TRIGGER fail_batch BEFORE DELETE ON memories WHEN OLD.id='b' BEGIN SELECT RAISE(ABORT,'fixture failure'); END"); raw.close(true);
    await expect(store.applyMaintenance(plan, { confirm: true, backupDirectory: root })).rejects.toThrow();
    expect(await store.exportAll()).toEqual(original);
    expect((await store.search("原文"))[0]).toBeDefined();
    const planFile = join(root, "plan.json"); writeFileSync(planFile, JSON.stringify(plan));
    expect(await runCli(["maintain", "apply", planFile], io, () => { throw Error("不能创建 store"); })).toBe(2);
    expect(await runCli(["maintain", "plan", "--ids", "a,a"], io, () => { throw Error("参数错误不能创建 store"); })).toBe(2);
    expect(await runCli(["maintain", "scan", "--before", "1d", "--json"], io, () => store)).toBe(0);
    expect(JSON.parse(out.pop()!).older.sort()).toEqual(["a", "b"]);
    const call = async (name: string, args: unknown) => {
      const reply = await handleRpcBody(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), store);
      return (reply.body as { result: { isError?: boolean; structuredContent: unknown } }).result;
    };
    expect((await call("memory_maintenance_apply", { plan, confirm: false })).isError).toBe(true);
    expect((await call("memory_maintenance_plan", { ids: ["a", "b"], replacement: { content: " " } })).isError).toBe(true);
    const planned = await call("memory_maintenance_plan", { ids: ["a"] });
    expect((await call("memory_maintenance_apply", { plan: planned.structuredContent, confirm: true })).isError).not.toBe(true);
    expect(await store.get("a")).toBeNull(); expect(await store.get("b")).not.toBeNull();
  } finally {
    store.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("memobox-maintenance-fault-")) throw Error("清理路径越界");
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});
