import { expect, test } from "bun:test";
import { planRelease, readRegistry } from "./plan.mjs";

const candidate = { eventName: "push", ref: "refs/heads/main", repository: "bilbilmyc/memobox", name: "memobox", version: "2.6.3", publishedVersions: ["2.6.1", "2.6.2"], latest: "2.6.2" };

test("新的正式版本只在本仓库 main 推送时发布", () => {
  expect(planRelease(candidate)).toMatchObject({ publish: true, version: "2.6.3", tag: "latest" });
  for (const input of [
    { ref: "refs/heads/feature" }, { ref: "refs/tags/v2.6.3" }, { eventName: "pull_request" },
    { eventName: "workflow_dispatch" }, { repository: "someone/memobox" },
  ]) expect(planRelease({ ...candidate, ...input }).publish).toBe(false);
});

test("开发版跳过，已发布版本重跑幂等，未发布的旧版本禁止覆盖 latest", () => {
  for (const version of ["2.6.3-dev.0", "2.6.3-beta.1", "2.6.3-rc.1", "2.6.3+build.4"]) expect(planRelease({ ...candidate, version }).publish).toBe(false);
  expect(planRelease({ ...candidate, version: "2.6.2" }).publish).toBe(false);
  expect(() => planRelease({ ...candidate, version: "2.6.0" })).toThrow("禁止自动回退");
});

test("正式版本按数字比较；错误包名、private、非法版本明确失败", () => {
  expect(planRelease({ ...candidate, version: "2.10.0", latest: "2.9.9" }).publish).toBe(true);
  for (const input of [{ name: "different-package" }, { privatePackage: true }, { version: "2.6" }, { version: "2.6.3\npublish=true" }, { version: "999999999999999999999.0.0" }]) {
    expect(() => planRelease({ ...candidate, ...input })).toThrow();
  }
});

test("registry 只有 404 可以视为未发布，网络与服务故障不能误判成新版本", async () => {
  expect(await readRegistry(async () => new Response(null, { status: 404 }))).toEqual({ publishedVersions: [], latest: undefined });
  for (const status of [401, 429, 503]) await expect(readRegistry(async () => new Response(null, { status }))).rejects.toThrow("查询失败");
  await expect(readRegistry(async () => { throw Error("offline"); })).rejects.toThrow("offline");
  await expect(readRegistry(async () => Response.json({}))).rejects.toThrow("无效版本数据");
  expect(await readRegistry(async () => Response.json({ versions: { "2.6.2": {} }, "dist-tags": { latest: "2.6.2" } }))).toEqual({ publishedVersions: ["2.6.2"], latest: "2.6.2" });
});
