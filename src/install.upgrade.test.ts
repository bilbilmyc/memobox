import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { installCodex, installPi, installClaude } from "./install";

test("三家客户端的旧接线仅在 --force 后更新，保留其他配置并备份完整原文件", async () => {
  const root = mkdtempSync(join(tmpdir(), "memobox-install-upgrade-")), next = { command: join(root, "中文 '原生程序.exe"), args: [], env: { MEMOBOX_DB_PATH: join(root, "新库.db") } };
  try {
    const codex = join(root, ".codex", "config.toml"); mkdirSync(dirname(codex), { recursive: true });
    const original = '# 保留注释\nmodel = "user-model"\nnotes = """\n[mcp_servers.memobox]\n这是字符串，不是配置段\n"""\n[mcp_servers.other]\ncommand = "other"\n[mcp_servers.memobox]\ncommand = "old-bun"\nargs = ["old.ts"]\n[mcp_servers.memobox.env]\nOLD_KEY = "preserved-in-backup"\n[profile.other]\nx = 3\n';
    writeFileSync(codex, original);
    expect((await installCodex(next, root)).ok).toBe(true); expect(readFileSync(codex, "utf8")).toBe(original);
    expect((await installCodex(next, root, true)).ok).toBe(true);
    const parsed = Bun.TOML.parse(readFileSync(codex, "utf8")) as { model: string; mcp_servers: { memobox: { command: string; args: string[] }; other: { command: string } }; profile: { other: { x: number } } };
    expect(parsed.model).toBe("user-model"); expect(parsed.mcp_servers.other.command).toBe("other"); expect(parsed.profile.other.x).toBe(3);
    expect(parsed.mcp_servers.memobox.command).toBe(next.command); expect(parsed.mcp_servers.memobox.args).toEqual([]);
    expect(readFileSync(join(dirname(codex), readdirSync(dirname(codex)).find(name => name.startsWith("config.toml.bak-"))!), "utf8")).toBe(original);
    for (const client of ["pi", "claude"] as const) {
      const path = client === "pi" ? join(root, ".pi", "agent", "mcp.json") : join(root, ".claude.json"); mkdirSync(dirname(path), { recursive: true });
      const before = JSON.stringify({ userOption: "retained", mcpServers: { memobox: { command: "old", args: ["src.ts"] }, other: { command: "other" } } }); writeFileSync(path, before);
      const install = client === "pi" ? installPi : installClaude;
      await install(next, root); expect(readFileSync(path, "utf8")).toBe(before);
      expect((await install(next, root, true)).ok).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ userOption: "retained", mcpServers: { memobox: next, other: { command: "other" } } });
      expect(readdirSync(dirname(path)).some(name => name.startsWith(basename(path) + ".bak-"))).toBe(true);
      writeFileSync(path, '{broken'); expect((await install(next, root, true)).ok).toBe(false); expect(readFileSync(path, "utf8")).toBe('{broken');
    }
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("memobox-install-upgrade-")) throw Error("清理路径越界");
    rmSync(root, { recursive: true, force: true });
  }
});
