/** 发布资格单独判定，不依赖 npm 登录凭据，也不自动改版本号。 */
import { readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function parts(version) {
  const values = version.split(".").map(Number);
  if (!values.every(Number.isSafeInteger)) throw Error("版本号数值超出安全范围");
  return values;
}

/**
 * @param {{eventName:string, ref:string, repository:string, name:string, version:string,
 * publishedVersions:string[], latest?:string, privatePackage?:boolean}} input
 */
export function planRelease(input) {
  const skip = (reason) => ({ publish: false, reason, version: input.version, tag: "latest" });
  if (input.eventName !== "push" || input.ref !== "refs/heads/main" || input.repository !== "bilbilmyc/memobox") return skip("只有本仓库 main 推送可发布");
  if (input.name !== "memobox" || input.privatePackage) throw Error("发布包名或 private 设置与 memobox 不符");
  if (!semver.test(input.version)) throw Error("package.json 的版本号不是有效语义版本");
  if (!stable.test(input.version)) return skip("开发版、预发行版及带构建后缀的版本不自动发布");
  const target = parts(input.version);
  if (input.publishedVersions.includes(input.version)) return skip("该版本已发布，保持幂等");
  if (input.latest !== undefined) {
    if (!stable.test(input.latest)) throw Error("npm latest 不是正式版本，需人工核对");
    const latest = parts(input.latest);
    for (let i = 0; i < 3; i++) {
      if (target[i] > latest[i]) break;
      if (target[i] < latest[i] || i === 2) throw Error("新版本必须大于 npm latest，禁止自动回退正式版");
    }
  }
  return { publish: true, reason: "新的正式版本", version: input.version, tag: "latest" };
}

/**
 * 只把明确 404 当作包不存在；网络、限流和服务器错误必须让发布失败。
 * @param {(url:string, init?:RequestInit)=>Promise<Response>} fetchFn
 */
export async function readRegistry(fetchFn = fetch) {
  const response = await fetchFn("https://registry.npmjs.org/memobox", { signal: AbortSignal.timeout(10000) });
  if (response.status === 404) return { publishedVersions: [], latest: undefined };
  if (!response.ok) throw Error("npm registry 查询失败：HTTP " + response.status);
  const data = await response.json();
  if (!data.versions || typeof data.versions !== "object" || Array.isArray(data.versions) ||
      (data["dist-tags"]?.latest !== undefined && typeof data["dist-tags"].latest !== "string")) throw Error("npm registry 返回无效版本数据");
  return { publishedVersions: Object.keys(data.versions), latest: data["dist-tags"]?.latest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const context = { eventName: process.env.GITHUB_EVENT_NAME ?? "", ref: process.env.GITHUB_REF ?? "", repository: process.env.GITHUB_REPOSITORY ?? "",
    name: pkg.name, version: pkg.version, privatePackage: pkg.private, publishedVersions: [] };
  // 开发版和非主分支先返回，不发起无意义的 registry 请求。
  const preliminary = planRelease(context);
  const plan = preliminary.publish ? planRelease({ ...context, ...await readRegistry() }) : preliminary;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `publish=${plan.publish}\nversion=${plan.version}\ntag=${plan.tag}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### npm 发布判定\n\n${plan.version}：${plan.reason}\n`);
  console.log(JSON.stringify(plan));
}
