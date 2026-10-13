import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { validateEndpoint } from "./endpoint.mjs";

test("正常 HTTP 请求容忍 200ms 调度延迟，挂起端点仍单独验证短超时降级", async () => {
  const root = mkdtempSync(join(tmpdir(), "memobox-endpoint-timing-"));
  try {
    expect(await validateEndpoint(process.execPath, [resolve("src/cli.ts")], root, process.env, { responseDelayMs: 200 })).toBe(true);
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("memobox-endpoint-timing-")) throw Error("cleanup escape");
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 30000);
