import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { installPi } from "./install";
import { TOOLS } from "./lib/mcp";
import { SQLiteStore } from "./db/sqlite-store";

test("pi 安装可自动发现的扩展，工厂无进程，真实 MCP 工具共享同库且重启可用", async () => {
  const root = mkdtempSync(join(tmpdir(), "memobox-pi-product-"));
  const db = join(root, "shared.db"), path = join(root, ".pi", "agent", "extensions", "memobox.js");
  try {
    expect((await installPi({ command: process.execPath, args: [resolve("src/cli.ts")], env: { MEMOBOX_DB_PATH: db, MEMOBOX_CONFIG_PATH: join(root, "config.json") } }, root)).ok).toBe(true);
    expect(existsSync(path)).toBe(true);
    const handlers = new Map<string, Function>(), tools: any[] = [];
    const extension = (await import(path)).default;
    await extension({ on(name: string, handler: Function) { handlers.set(name, handler); }, registerTool(tool: any) { tools.push(tool); } });
    expect(existsSync(db)).toBe(false);
    expect(tools.map(tool => tool.name)).toEqual(TOOLS.map(tool => "memobox_" + tool.name));
    const invoke = (name: string, params: unknown, signal?: AbortSignal) => tools.find(tool => tool.name === "memobox_" + name).execute("call", params, signal);
    const saved = await invoke("memory_save", { content: "pi 实际扩展共享标记", entities: ["项目甲"] });
    expect(saved.content[0].text).toContain("saved memory");
    const store = new SQLiteStore(null, db);
    try {
      const rows = await store.search("共享标记"); expect(rows.length).toBe(1);
      await store.update(rows[0].id, { content: "pi 扩展跨进程修订" });
      expect((await invoke("memory_search", { query: "跨进程修订" })).details.memories[0].id).toBe(rows[0].id);
      let missing: unknown; try { await invoke("memory_forget", { id: "missing" }); } catch (error) { missing = error; } expect(missing).toBeInstanceOf(Error);
      const controller = new AbortController(); controller.abort();
      await expect(invoke("memory_save", { content: "不能保存" }, controller.signal)).rejects.toThrow();
      expect((await store.query({ text: "不能保存" })).length).toBe(0);
      await handlers.get("session_shutdown")!(); 
      expect((await invoke("memory_get", { id: rows[0].id })).details.memory.content).toContain("跨进程修订");
    } finally { store.close(); await handlers.get("session_shutdown")!(); }
    const before = readFileSync(path, "utf8"); await installPi({ command: "other", args: [] }, root); expect(readFileSync(path, "utf8")).toBe(before);
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("memobox-pi-product-")) throw Error("清理路径越界");
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);




