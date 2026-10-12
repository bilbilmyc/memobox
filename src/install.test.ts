import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeAddArgs,
  codexTomlBlock,
  detectClaude,
  detectCodex,
  detectPi,
  installCodex,
  installPi,
  piMerge,
} from "./install";

const entry = {
  command: "C:/Users/t/.bun/bin/bun.exe",
  args: ["C:/memobox/src/cli.ts"],
  env: { EMBEDDING_API_BASE: "https://api.example.com/v1" },
};

// 每个用例独立临时「家目录」，互不串
const homes: string[] = [];
const newHome = () => {
  const h = mkdtempSync(join(tmpdir(), "memobox-install-"));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

describe("install 纯函数", () => {
  test("codexTomlBlock：基本字符串可解析，env 进内联表", () => {
    const block = codexTomlBlock(entry);
    expect(block).toContain("[mcp_servers.memobox]");
    expect(Bun.TOML.parse(block)).toMatchObject({ mcp_servers: { memobox: entry } });
    expect(block).toContain(`EMBEDDING_API_BASE = "https://api.example.com/v1"`);
  });

  test("codexTomlBlock：无 env 时不输出 env 行", () => {
    const block = codexTomlBlock({ command: "bun", args: ["x"] });
    expect(block).not.toContain("env =");
  });

  test("piMerge：保留用户已有条目，写入 memobox", () => {
    const merged = piMerge(
      { mcpServers: { other: { command: "foo" } }, extra: 1 },
      entry
    );
    expect(merged.mcpServers.other).toEqual({ command: "foo" });
    const mm = merged.mcpServers.memobox as { command: string; args: string[] };
    expect(mm.command).toBe(entry.command);
    expect(mm.args).toEqual(entry.args);
    expect((merged as Record<string, unknown>).extra).toBe(1);
  });

  test("claudeAddArgs：--scope user、--env、-- 分隔、命令殿后", () => {
    const args = claudeAddArgs(entry);
    expect(args.slice(0, 6)).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "--env",
      "EMBEDDING_API_BASE=https://api.example.com/v1",
    ]);
    const sep = args.indexOf("--");
    expect(args[sep - 1]).toBe("memobox");
    expect(args.slice(sep + 1)).toEqual([entry.command, ...entry.args]);
  });
});

describe("install 文件操作（临时家目录）", () => {
  test("installCodex：首次追加、二次幂等跳过", async () => {
    const home = newHome();
    const first = await installCodex(entry, home);
    expect(first.ok).toBe(true);
    const path = join(home, ".codex", "config.toml");
    const once = readFileSync(path, "utf-8");
    expect(once).toContain("[mcp_servers.memobox]");

    // 已配置 → 跳过且内容不变
    const second = await installCodex(entry, home);
    expect(second.ok).toBe(true);
    expect(second.message).toContain("已配置过");
    expect(readFileSync(path, "utf-8")).toBe(once);
  });

  test("installCodex：追加时不动用户已有内容", async () => {
    const home = newHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "foo"\n',
      "utf-8"
    );
    await installCodex(entry, home);
    const after = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
    expect(after.startsWith('model = "gpt-5"')).toBe(true);
    expect(after).toContain("[mcp_servers.memobox]");
  });

  test("installPi：合并进已有 mcp.json，坏 JSON 拒绝动文件", async () => {
    const home = newHome();
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "mcp.json"),
      JSON.stringify({ mcpServers: { existing: { command: "x" } } }),
      "utf-8"
    );
    const r = await installPi(entry, home);
    expect(r.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(join(home, ".pi", "agent", "mcp.json"), "utf-8"));
    expect(cfg.mcpServers.existing).toEqual({ command: "x" });
    expect(cfg.mcpServers.memobox.args).toEqual(entry.args);

    // 幂等：再装一次报告已配置过
    const again = await installPi(entry, home);
    expect(again.message).toContain("已配置过");

    // 坏 JSON：拒绝而不是覆盖
    writeFileSync(join(home, ".pi", "agent", "mcp.json"), "{oops", "utf-8");
    const bad = await installPi(entry, home);
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("不是合法 JSON");
  });
});

describe("detect 探测（临时家目录）", () => {
  test("三家：未配置 → configured false 且给出安装提示", () => {
    const home = newHome();
    expect(detectCodex(home)).toMatchObject({ client: "codex", configured: false });
    expect(detectPi(home)).toMatchObject({ client: "pi", configured: false });
    expect(detectClaude(home)).toMatchObject({ client: "claude", configured: false });
    expect(detectCodex(home).detail).toContain("memobox install codex");
  });

  test("安装后探测变绿，且不误报别家条目", async () => {
    const home = newHome();
    await installCodex(entry, home);
    await installPi(entry, home);
    expect(detectCodex(home).configured).toBe(true);
    expect(detectPi(home).configured).toBe(true);
    // claude 家目录里没有它的配置文件——仍报未配置
    expect(detectClaude(home).configured).toBe(false);
  });

  test("别家同名键不误报：只有 other 条目时 codex 未配置", () => {
    const home = newHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      "[mcp_servers.other]\ncommand = 'foo'\n",
      "utf-8"
    );
    expect(detectCodex(home).configured).toBe(false);
  });

  test("claude：~/.claude.json 里有 mcpServers.memobox 即配置", () => {
    const home = newHome();
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { memobox: { command: "bun" } } }),
      "utf-8"
    );
    expect(detectClaude(home).configured).toBe(true);
  });
});
