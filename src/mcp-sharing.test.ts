import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./cli.ts", import.meta.url));
type Reply = { result?: { content?: { text: string }[]; isError?: boolean }; error?: unknown };

/** 使用真正的 Bun 子进程和 stdio；每个客户端按顺序收发协议消息。 */
function mcpClient(env: Record<string, string | undefined>, configured?: { command: string; args: string[] }) {
  const child = Bun.spawn(configured ? [configured.command, ...configured.args] : [process.execPath, entry], {
    env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const diagnostics = new Response(child.stderr).text();
  let buffer = "";
  let sequence = 0;
  async function call(method: string, params?: unknown): Promise<Reply> {
    const id = ++sequence;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await child.stdin.flush();
    let timeout: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        (async () => {
          while (!buffer.includes("\n")) {
            const next = await reader.read();
            if (next.done) throw new Error(`MCP 意外退出：${await diagnostics}`);
            buffer += next.value;
          }
          const end = buffer.indexOf("\n");
          const reply = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          expect(reply.id).toBe(id);
          expect(reply.error).toBeUndefined();
          expect(reply.result?.isError).not.toBe(true);
          return reply;
        })(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`MCP ${method} 超时`)), 5000);
        }),
      ]);
    } finally { clearTimeout(timeout!); }
  }
  return {
    call,
    async initialize() {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sharing-test", version: "1" } });
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    },
    async close() {
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([child.exited, new Promise<void>(resolve => {
          timer = setTimeout(() => { child.kill(); resolve(); }, 1000);
        })]);
        await child.exited;
        await reader.cancel();
        await diagnostics;
      } finally { clearTimeout(timer!); }
    },
  };
}

const text = (reply: Reply) => reply.result?.content?.[0]?.text ?? "";

describe("两个真实 MCP 进程共享 SQLite", () => {
  for (const semantic of [false, true]) {
    test(`安装器生成的配置：中文和单引号路径，${semantic ? "语义" : "关键词"}双进程共享`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "memobox-mcp-sharing-install-"));
      const home = join(dir, "中文 O'Brien 用户目录"), config = join(dir, "中文 配置.json");
      writeFileSync(config, "{}");
      const server = semantic ? Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const { input } = await request.json() as { input: string };
        return Response.json({ data: [{ embedding: /alpha|synonym/.test(input) ? [1, 0] : [0, 1] }] });
      } }) : null;
      const env = { ...process.env, HOME: home, USERPROFILE: home,
        MEMOBOX_DB_PATH: join(dir, "中文 共享.db"), MEMOBOX_CONFIG_PATH: config,
        EMBEDDING_API_BASE: server ? `http://127.0.0.1:${server.port}/v1` : "", EMBEDDING_API_KEY: "", EMBEDDING_MODEL: "installed-stub", EMBEDDING_DIM: "2" };
      let a: ReturnType<typeof mcpClient> | undefined, b: ReturnType<typeof mcpClient> | undefined;
      async function cli(args: string[]) {
        const proc = Bun.spawn([process.execPath, fileURLToPath(new URL("./cli.ts", import.meta.url)), ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const stdout = new Response(proc.stdout).text(), stderr = new Response(proc.stderr).text();
        const [code, out, err] = await Promise.all([proc.exited, stdout, stderr]);
        expect(code).toBe(0); expect(err).toBe(""); return out;
      }
      try {
        // 确认 Bun 真正采用临时家目录后才允许安装器写文件。
        const probe = Bun.spawn([process.execPath, "-e", "console.log(require('node:os').homedir())"], { env, stdin: "ignore", stdout: "pipe" });
        expect((await new Response(probe.stdout).text()).trim()).toBe(home);
        expect(await probe.exited).toBe(0);
        await cli(["install", "codex"]);
        const installedPath = join(home, ".codex", "config.toml"), original = readFileSync(installedPath, "utf8");
        await cli(["install", "codex"]);
        expect(readFileSync(installedPath, "utf8")).toBe(original);
        const installed = (Bun.TOML.parse(original) as { mcp_servers: { memobox: { command: string; args: string[]; env: Record<string, string> } } }).mcp_servers.memobox;
        expect(installed.env.MEMOBOX_DB_PATH).toBe(env.MEMOBOX_DB_PATH);
        expect(installed.env.MEMOBOX_CONFIG_PATH).toBe(config);
        expect(installed.env.EMBEDDING_DIM).toBe("2");
        const appEnv: Record<string, string | undefined> = { ...env };
        for (const key of ["MEMOBOX_DB_PATH", "MEMOBOX_CONFIG_PATH", "EMBEDDING_DIM", "EMBEDDING_API_BASE", "EMBEDDING_MODEL"]) delete appEnv[key];
        a = mcpClient({ ...appEnv, ...installed.env }, installed);
        b = mcpClient({ ...appEnv, ...installed.env }, installed);
        await Promise.all([a.initialize(), b.initialize()]);
        await a.call("tools/call", { name: "memory_search", arguments: { query: "warmup" } });
        const saved = text(await b.call("tools/call", { name: "memory_save", arguments: { content: "alpha 中文安装回归" } }));
        const id = saved.match(/saved memory ([\w-]+)/)![1], query = semantic ? "synonym" : "alpha";
        expect(text(await a.call("tools/call", { name: "memory_search", arguments: { query } }))).toContain("alpha 中文安装回归");
        await cli(["forget", id]);
        for (const client of [a, b]) expect(text(await client.call("tools/call", { name: "memory_search", arguments: { query } }))).not.toContain("alpha 中文安装回归");
      } finally {
        await Promise.all([a?.close(), b?.close()]); server?.stop(true);
        if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith("memobox-mcp-sharing-install-")) throw Error("临时测试目录越界");
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
      }
    }, 15000);
  }
  for (const semantic of [false, true]) {
    test(`${semantic ? "混合检索" : "关键词检索"}：预热后双向写入、并发保存和 CLI 遗忘立即可见`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "memobox-mcp-sharing-"));
      const config = join(dir, "config.json");
      writeFileSync(config, "{}");
      // 语义路径用确定性本地假端点，不依赖模型下载或用户的 API 配置。
      const server = semantic ? Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
          const body = await request.json() as { input: string };
          const embedding = /alpha|synonym/.test(body.input) ? [1, 0] : [0, 1];
          return Response.json({ data: [{ embedding }] });
        },
      }) : null;
      const env = {
        ...process.env,
        MEMOBOX_DB_PATH: join(dir, "memory.db"), MEMOBOX_CONFIG_PATH: config,
        EMBEDDING_API_BASE: server ? `http://127.0.0.1:${server.port}/v1` : "",
        EMBEDDING_API_KEY: "", EMBEDDING_MODEL: "sharing-stub", EMBEDDING_DIM: "2",
      };
      const a = mcpClient(env);
      const b = mcpClient(env);
      try {
        // 同时启动，验证建库/迁移遇到另一写连接时能够等待。
        await Promise.all([a.initialize(), b.initialize()]);
        for (const client of [a, b]) await client.call("tools/call", { name: "memory_search", arguments: { query: "warmup" } });
        const saved = text(await b.call("tools/call", { name: "memory_save", arguments: { content: "alpha shared memory" } }));
        const id = saved.match(/saved memory ([\w-]+)/)?.[1];
        expect(id).toBeDefined();
        const query = semantic ? "synonym" : "alpha";
        expect(text(await a.call("tools/call", { name: "memory_search", arguments: { query } }))).toContain("alpha shared memory");
        await a.call("tools/call", { name: "memory_update", arguments: { id, content: "alpha 修订后的共享记忆", entities: ["共享项目"], kind: "decision", source: "another-agent" } });
        expect(text(await b.call("tools/call", { name: "memory_search", arguments: { query } }))).toContain("alpha 修订后的共享记忆");
        const full = JSON.parse(text(await b.call("tools/call", { name: "memory_get", arguments: { id } })));
        expect(full.memory.kind).toBe("decision");
        expect(full.memory.source).toBe("another-agent");
        for (const client of [a, b]) {
          expect(text(await client.call("tools/call", { name: "memory_search", arguments: { query, source: "another-agent", entity: "共享项目", kind: "decision" } }))).toContain("alpha 修订后的共享记忆");
          expect(text(await client.call("tools/call", { name: "memory_search", arguments: { query, source: "other-agent" } }))).toBe("no matching memories");
        }
        await a.call("tools/call", { name: "memory_save", arguments: { content: "walrus shared memory" } });
        expect(text(await b.call("tools/call", { name: "memory_search", arguments: { query: "walrus" } }))).toContain("walrus shared memory");
        await Promise.all([
          a.call("tools/call", { name: "memory_save", arguments: { content: "parallel zebra" } }),
          b.call("tools/call", { name: "memory_save", arguments: { content: "parallel giraffe" } }),
        ]);
        for (const client of [a, b]) {
          const hits = text(await client.call("tools/call", { name: "memory_search", arguments: { query: "parallel" } }));
          expect(hits).toContain("parallel zebra");
          expect(hits).toContain("parallel giraffe");
        }
        const forgotten = Bun.spawn([process.execPath, entry, "forget", id!], { env, stdout: "pipe", stderr: "pipe" });
        const stdout = new Response(forgotten.stdout).text();
        const stderr = new Response(forgotten.stderr).text();
        expect(await forgotten.exited).toBe(0);
        await Promise.all([stdout, stderr]);
        for (const client of [a, b]) {
          const hits = text(await client.call("tools/call", { name: "memory_search", arguments: { query } }));
          expect(hits).not.toContain("alpha shared memory");
          if (semantic) expect(hits).toBe("no matching memories");
        }
      } finally {
        await Promise.all([a.close(), b.close()]);
        server?.stop(true);
        if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith("memobox-mcp-sharing-")) throw new Error("测试目录超出临时目录范围");
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
      }
    }, 15000);
  }
});
