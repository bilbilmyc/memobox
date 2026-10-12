import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { runCli } from "../cli";

test("配置 CLI 校验后原子写入、隐藏凭据，坏配置不被部分更新覆盖，重置保留备份", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memobox-config-product-"));
  const path = join(dir, "中文 配置.json"), previous = process.env.MEMOBOX_CONFIG_PATH;
  process.env.MEMOBOX_CONFIG_PATH = path;
  const run = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await runCli(args, { out: s => out.push(s), err: s => err.push(s) }, () => { throw Error("配置命令不应创建存储"); });
    return { code, out, err };
  };
  try {
    expect((await run(["config", "set", "embedding.base", "https://user:password@example.invalid/v1?token=secret-token"])).code).toBe(0);
    expect((await run(["config", "set", "embedding.key", "regression-config-secret"])).code).toBe(0);
    expect((await run(["config", "set", "embedding.dimensions", "512"])).code).toBe(0);
    const show = await run(["config", "show", "--json"]);
    expect(show.code).toBe(0);
    expect(show.out.join("\n")).not.toMatch(/password|secret-token|regression-config-secret/);
    expect(JSON.parse(show.out[0]).values.embedding.dimensions).toBe(512);
    const original = readFileSync(path, "utf8");
    expect((await run(["config", "set", "embedding.dimensions", "-1"])).code).toBe(2);
    expect((await run(["config", "set", "unknown.field", "x"])).code).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(original);
    writeFileSync(path, "{malformed private value");
    expect((await run(["config", "set", "embedding.model", "bge-m3"])).code).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("{malformed private value");
    expect((await run(["config", "reset"])).code).toBe(0);
    const backup = readdirSync(dir).find(name => name.startsWith("中文 配置.json.backup-"));
    expect(backup).toBeDefined();
    expect(readFileSync(join(dir, backup!), "utf8")).toBe("{malformed private value");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
    expect(readdirSync(dir).some(name => name.endsWith(".tmp"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.MEMOBOX_CONFIG_PATH; else process.env.MEMOBOX_CONFIG_PATH = previous;
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith("memobox-config-product-")) throw Error("配置测试目录越界");
    rmSync(dir, { recursive: true, force: true });
  }
});
