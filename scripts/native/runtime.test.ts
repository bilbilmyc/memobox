import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { ensureBinary, platformAsset } from "../../bin/runtime.js";

test("平台下载校验字节，并发安装只下载一次，缓存和离线使用不联网，损坏下载拒绝执行", async () => {
  const root = mkdtempSync(join(tmpdir(), "memobox-downloader-"));
  const bytes = Buffer.from("fixture-only: not executable"), compressed = gzipSync(bytes), hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const asset = { version: "2.6.3-beta.0", filename: "memobox", asset: "fixture.gz", sha256: hash(bytes), compressedSha256: hash(compressed), size: bytes.length, compressedSize: compressed.length };
  const manifest = { version: asset.version, platforms: { "linux-x64": asset } }; let calls = 0, corrupt = false;
  const server = Bun.serve({ port: 0, fetch() { calls++; return new Response(corrupt ? gzipSync(Buffer.alloc(bytes.length, 42)) : compressed); } });
  const options = { platform: "linux", arch: "x64", cache: root, base: `http://127.0.0.1:${server.port}` };
  try {
    const binaries = await Promise.all([ensureBinary(manifest, options), ensureBinary(manifest, options)]);
    expect(binaries[0]).toBe(binaries[1]); expect(calls).toBe(1); expect(readFileSync(binaries[0])).toEqual(bytes);
    server.stop(true);
    expect(await ensureBinary(manifest, options)).toBe(binaries[0]);
    expect(await ensureBinary(manifest, { ...options, override: binaries[0] })).toBe(binaries[0]);
    expect(() => platformAsset(manifest, "linux", "ia32")).toThrow("尚未支持");
  } finally { server.stop(true); }
  const badServer = Bun.serve({ port: 0, fetch() { return new Response(gzipSync(Buffer.alloc(bytes.length, 42))); } });
  try {
    const badCache = join(root, "bad");
    await expect(ensureBinary(manifest, { ...options, cache: badCache, base: `http://127.0.0.1:${badServer.port}` })).rejects.toThrow();
    expect(existsSync(join(badCache, asset.version, "linux-x64", "memobox"))).toBe(false);
    expect(existsSync(join(badCache, asset.version, "linux-x64", "download.lock"))).toBe(false);
  } finally {
    badServer.stop(true);
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("memobox-downloader-")) throw Error("清理路径越界");
    rmSync(root, { recursive: true, force: true });
  }
});
