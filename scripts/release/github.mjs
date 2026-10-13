import assert from "node:assert/strict";

/** 只读解析发行标签对应的提交；元数据故障不能当作首次发行。 */
export function releaseCommit(api, tag) {
  const name = encodeURIComponent(tag);
  // GitHub commits/<未知标签> 返回 422；refs 接口用 404 表示确实不存在。
  const reference = api("git/ref/tags/" + name, true);
  return reference ? api("commits/" + name) : null;
}

/** 查找公开发行或草稿；按标签的端点不会返回草稿。 */
export function releaseForTag(api, tag) {
  const published = api("releases/tags/" + encodeURIComponent(tag), true);
  if (published) return published;
  for (let page = 1; ; page++) {
    const rows = api("releases?per_page=100&page=" + page);
    if (!Array.isArray(rows)) throw Error("Invalid release list");
    const found = rows.find(release => release.tag_name === tag);
    if (found) return found;
    if (rows.length < 100) return null;
  }
}
/** 准备发行草稿；已有公开标签和已上传的资产不能跨提交复用。 */
export function prepareRelease(api, gh, { tag, revision, title, notesFile }) {
  let release = releaseForTag(api, tag);
  const commit = releaseCommit(api, tag);
  if (commit) assert.equal(commit.sha, revision, "Existing release tag targets another commit");
  if (!release) {
    gh(["release", "create", tag, "--target", revision, "--draft", "--title", title, "--notes-file", notesFile]);
    release = releaseForTag(api, tag);
    assert(release, "Created draft release was not found");
  }
  if (release.draft) {
    if (release.target_commitish !== revision) {
      // 首次发布可能只留下空草稿；修复 PR 的新提交可继续完成它。
      assert(!commit, "Cannot retarget a draft with an existing tag");
      assert(Array.isArray(release.assets) && release.assets.length === 0, "Cannot retarget a draft with existing assets");
      gh(["release", "edit", tag, "--target", revision]);
      release = api("releases/" + release.id);
      assert(release?.draft && release.tag_name === tag, "Updated draft release was not found");
    }
    assert.equal(release.target_commitish, revision, "Draft release targets another commit");
  } else {
    assert.equal(commit?.sha, revision, "Published release tag is missing or targets another commit");
  }
  return release;
}
