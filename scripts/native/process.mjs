import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function runProcess(command, args, { env = process.env, cwd = process.cwd(), timeout = 20000, expected = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", text => { stdout += text; }); child.stderr.on("data", text => { stderr += text; });
    const timer = setTimeout(() => { child.kill(); reject(Error("Process timed out: " + args[0])); }, timeout);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); if (code !== expected) reject(Error(`Exit ${code}, expected ${expected}: ${args.join(" ")}\n${stderr}\n${stdout}`)); else resolve({ stdout: stdout.trim(), stderr, code }); });
  });
}

/** 真 stdio MCP 测试客户端；stdout 中任何非 JSON 都是验收失败。 */
export function mcpClient(command, args, env) {
  const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map(); let sequence = 0, protocolError;
  const fail = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on("error", fail); child.on("exit", () => fail(Error("MCP exited"))); child.stderr.resume();
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const response = JSON.parse(line), item = pending.get(response.id); if (!item) return;
      clearTimeout(item.timer); pending.delete(response.id);
      if (response.error) item.reject(Error("MCP RPC error: " + JSON.stringify(response.error))); else item.resolve(response.result);
    } catch (error) { protocolError = error; fail(error); }
  });
  return {
    child,
    call(method, params, timeout = 20000) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error("MCP timed out: " + method)); }, timeout);
        pending.set(id, { timer, resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    tool(name, args, timeout) { return this.call("tools/call", { name, arguments: args }, timeout); },
    async close(signal) {
      fail(Error("Test complete")); if (signal) child.kill(signal); else child.stdin.end();
      let timer;
      try {
        const result = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(Error("MCP/launcher failed to exit")); }, 5000); })]);
        if (protocolError) throw protocolError; return result;
      } finally { clearTimeout(timer); lines.close(); }
    },
  };
}
