import { test, expect } from "bun:test";
import { releaseCommit } from "./github.mjs";

test("首次发行先检查标签引用，缺失标签不访问会返回 422 的提交接口", () => {
  const calls: string[] = [];
  const api = (path: string, missing = false) => {
    calls.push(path);
    if (path === "git/ref/tags/v2.6.3" && missing) return null;
    throw Error("No commit found for SHA: v2.6.3 (HTTP 422)");
  };
  expect(releaseCommit(api, "v2.6.3")).toBeNull();
  expect(calls).toEqual(["git/ref/tags/v2.6.3"]);
});

test("已有轻量或注释标签使用提交接口解析，不把标签对象 SHA 当作提交", () => {
  for (const type of ["commit", "tag"]) {
    const calls: string[] = [];
    const api = (path: string) => {
      calls.push(path);
      return path.startsWith("git/ref/") ? { object: { type, sha: "tag-object" } } : { sha: "resolved-commit" };
    };
    expect(releaseCommit(api, "v2.6.3")).toEqual({ sha: "resolved-commit" });
    expect(calls).toEqual(["git/ref/tags/v2.6.3", "commits/v2.6.3"]);
  }
});

test("标签探测的权限、网络和服务故障继续失败，不隐式创建发行", () => {
  for (const reason of ["HTTP 401", "HTTP 500", "Network unavailable"]) {
    expect(() => releaseCommit(() => { throw Error(reason); }, "v2.6.3")).toThrow(reason);
  }
});
