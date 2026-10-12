import { test, expect } from "bun:test";
import { mkdtempSync, unlinkSync, rmSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteStore } from "./sqlite-store";

test("关闭检索后的存储立即释放 Windows 文件句柄，不依赖强制 GC", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memobox-close-")), path = join(directory, "memory.db");
  let store: SQLiteStore | null = new SQLiteStore(null, path);
  try {
    await store.save({ content: "用于连接释放的合成记忆" });
    await store.search("连接释放");
    store.close();
    // 故意保留 store 的引用：只关闭连接也应允许立即清理或替换数据库。
    expect(() => unlinkSync(path)).not.toThrow();
    expect(existsSync(path)).toBe(false);
    store.close();
  } finally {
    store?.close(); store = null;
    if (existsSync(path)) Bun.gc(true);
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("memobox-close-")) throw Error("测试清理路径越界");
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});
