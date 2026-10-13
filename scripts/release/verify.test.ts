import { test, expect } from "bun:test";
import { verifyPublishedRelease } from "./verify.mjs";

const receipt = { version: "2.6.3", integrity: "sha512-tested-tarball" };
const version = (provenance = true, integrity = receipt.integrity) => Response.json({
  version: receipt.version, dist: { integrity, ...(provenance ? { attestations: { url: "https://registry.npmjs.org/attestation" } } : {}) },
});
const registry = (latest: string) => Response.json({ versions: { "2.6.2": {}, "2.6.3": {} }, "dist-tags": { latest } });
function replay(responses: Response[]) {
  const calls: string[] = [], waits: number[] = [];
  return {
    calls, waits,
    fetchFn: async (url: string, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      calls.push(url);
      const response = responses.shift();
      if (!response) throw Error("Unexpected registry request");
      return response;
    },
    wait: async (ms: number) => { waits.push(ms); },
    attempts: 4, delayMs: 1,
  };
}

test("版本先可见而 latest 仍旧时只重试查询，直到两者一致", async () => {
  const io = replay([version(), registry("2.6.2"), version(), registry("2.6.3")]);
  await verifyPublishedRelease(receipt, io);
  expect(io.waits).toEqual([1]);
  expect(io.calls).toHaveLength(4);
});

test("版本索引和来源证明可延后可见，成功后不再等待", async () => {
  const io = replay([new Response(null, { status: 404 }), version(false), version(), registry("2.6.3")]);
  await verifyPublishedRelease(receipt, io);
  expect(io.waits).toEqual([1, 1]);
});

test("旧 latest 持续不变时有界失败，不误报发布完成", async () => {
  const io = { ...replay([version(), registry("2.6.2"), version(), registry("2.6.2")]), attempts: 2 };
  await expect(verifyPublishedRelease(receipt, io)).rejects.toThrow("registry 验证超时");
  expect(io.waits).toEqual([1]);
});

test("包完整性错误和权限错误立即失败，不用重试掩盖", async () => {
  const mismatch = replay([version(true, "sha512-another-tarball")]);
  await expect(verifyPublishedRelease(receipt, mismatch)).rejects.toThrow("Published tarball integrity mismatch");
  expect(mismatch.waits).toEqual([]);
  const denied = replay([new Response(null, { status: 403 })]);
  await expect(verifyPublishedRelease(receipt, denied)).rejects.toThrow("HTTP 403");
  expect(denied.waits).toEqual([]);
});

test("版本查询的限流和暂时故障继续按有限次数重试", async () => {
  const io = replay([new Response(null, { status: 429 }), new Response(null, { status: 503 }), version(), registry("2.6.3")]);
  await verifyPublishedRelease(receipt, io);
  expect(io.waits).toEqual([1, 1]);
});
