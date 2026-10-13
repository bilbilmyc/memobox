import { test, expect } from "bun:test";
import { releaseCommit, releaseForTag } from "./github.mjs";
import * as github from "./github.mjs";

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

test("首次创建的草稿能读取并复用，不重复创建或误判不存在", () => {
  const releases: Record<string, unknown>[] = [];
  const api = (path: string) => path.startsWith("releases/tags/") ? null : releases;
  expect(releaseForTag(api, "v2.6.3")).toBeNull();
  releases.push({ id: 42, tag_name: "v2.6.3", draft: true, target_commitish: "verified-commit", assets: [] });
  expect(releaseForTag(api, "v2.6.3")).toEqual(releases[0]);
  expect(releaseForTag(api, "v2.6.3")).toEqual(releases[0]);
});

test("已有正式发行直接返回，超过一页时仍能查找指定草稿", () => {
  const published = { id: 7, tag_name: "v2.6.2", draft: false };
  expect(releaseForTag(() => published, "v2.6.2")).toBe(published);
  const wanted = { id: 42, tag_name: "v2.6.3", draft: true };
  const api = (path: string) => path.startsWith("releases/tags/") ? null : path.endsWith("page=1")
    ? Array.from({ length: 100 }, (_, index) => ({ tag_name: "v0.0." + index })) : [wanted];
  expect(releaseForTag(api, "v2.6.3")).toEqual(wanted);
});

test("草稿列表查询失败或返回非法形状不能当作缺失发行", () => {
  expect(() => releaseForTag(path => path.startsWith("releases/tags/") ? null : (() => { throw Error("HTTP 401"); })(), "v2.6.3")).toThrow("HTTP 401");
  expect(() => releaseForTag(path => path.startsWith("releases/tags/") ? null : { invalid: true }, "v2.6.3")).toThrow("Invalid release list");
});

// 覆盖真实创建/恢复顺序：公开标签接口对草稿始终返回 404。
function releaseFixture(options: { draft?: boolean; target?: string; assets?: readonly { name: string }[]; tagSha?: string; absent?: boolean } = {}) {
  let release: Record<string, unknown> | null = options.absent ? null : {
    id: 42, tag_name: "v2.6.3", draft: options.draft ?? true,
    target_commitish: options.target ?? "old-commit", assets: options.assets ?? [],
  };
  const commands: string[][] = [];
  const api = (path: string) => {
    if (path.startsWith("releases/tags/")) return release?.draft === false ? release : null;
    if (path.startsWith("releases?")) return release ? [release] : [];
    if (path === "releases/42") return release;
    if (path.startsWith("git/ref/tags/")) return options.tagSha ? { ref: "refs/tags/v2.6.3" } : null;
    if (path.startsWith("commits/")) return { sha: options.tagSha };
    throw Error("Unexpected API path: " + path);
  };
  const gh = (args: string[]) => {
    commands.push(args);
    const target = args[args.indexOf("--target") + 1];
    if (args[1] === "create") release = { id: 42, tag_name: "v2.6.3", draft: true, target_commitish: target, assets: [] };
    else if (args[1] === "edit" && release) release = { ...release, target_commitish: target };
    else throw Error("Unexpected release command");
  };
  return { api, gh, commands };
}
const releaseOptions = { tag: "v2.6.3", revision: "new-commit", title: "memobox 2.6.3", notesFile: "docs/RELEASE-2.6.3.md" };

test("创建草稿后通过草稿接口读取；同提交重跑不重复创建", () => {
  const fixture = releaseFixture({ absent: true });
  expect(github.prepareRelease(fixture.api, fixture.gh, releaseOptions).draft).toBe(true);
  expect(github.prepareRelease(fixture.api, fixture.gh, releaseOptions).target_commitish).toBe("new-commit");
  expect(fixture.commands.map(args => args[1])).toEqual(["create"]);
});

test("修复提交只恢复无标签且无资产的遗留空草稿，并重新读取目标", () => {
  const fixture = releaseFixture();
  expect(github.prepareRelease(fixture.api, fixture.gh, releaseOptions).target_commitish).toBe("new-commit");
  expect(fixture.commands).toEqual([["release", "edit", "v2.6.3", "--target", "new-commit"]]);
  github.prepareRelease(fixture.api, fixture.gh, releaseOptions);
  expect(fixture.commands).toHaveLength(1);
});

test("已有标签或资产时不把其他提交的发行自动迁移", () => {
  for (const [options, reason] of [
    [{ assets: [{ name: "binary.gz" }] }, "Cannot retarget a draft with existing assets"],
    [{ tagSha: "old-commit" }, "Existing release tag targets another commit"],
    [{ draft: false, tagSha: "old-commit" }, "Existing release tag targets another commit"],
    [{ tagSha: "new-commit" }, "Cannot retarget a draft with an existing tag"],
  ] as const) {
    const fixture = releaseFixture(options);
    expect(() => github.prepareRelease(fixture.api, fixture.gh, releaseOptions)).toThrow(reason);
    expect(fixture.commands).toEqual([]);
  }
});

test("已公开的同提交发行只复用；缺失标签仍然失败", () => {
  const fixture = releaseFixture({ draft: false, tagSha: "new-commit" });
  expect(github.prepareRelease(fixture.api, fixture.gh, releaseOptions).draft).toBe(false);
  expect(fixture.commands).toEqual([]);
  const missing = releaseFixture({ draft: false });
  expect(() => github.prepareRelease(missing.api, missing.gh, releaseOptions)).toThrow("Published release tag is missing or targets another commit");
});

test("更新草稿失败或未生效时停止，不继续上传资产", () => {
  const fixture = releaseFixture();
  expect(() => github.prepareRelease(fixture.api, () => { throw Error("HTTP 403"); }, releaseOptions)).toThrow("HTTP 403");
  expect(() => github.prepareRelease(fixture.api, () => {}, releaseOptions)).toThrow("Draft release targets another commit");
});
