/** 只读解析发行标签对应的提交；元数据故障不能当作首次发行。 */
export function releaseCommit(api, tag) {
  const name = encodeURIComponent(tag);
  // GitHub commits/<未知标签> 返回 422；refs 接口用 404 表示确实不存在。
  const reference = api("git/ref/tags/" + name, true);
  return reference ? api("commits/" + name) : null;
}
