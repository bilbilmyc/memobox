/** 在隔离目录验证实际发行物；发布时复用已验收的 tarball，不重新打包。 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
import { validateTarball } from "../native/test-package.mjs";
import { planRelease, readRegistry } from "./plan.mjs";

const root = process.cwd(), pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const npmCli = [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find(existsSync);
if (!npmCli) throw Error("无法定位 Node 安装中的 npm CLI");
function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: "utf8", windowsHide: true, timeout: 120000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error("命令失败：" + basename(command) + "\n" + result.stderr + "\n" + result.stdout);
  return result.stdout.trim();
}
const npm = (args, options) => execute(process.execPath, [npmCli, ...args], options);
const digest = (path, algorithm = "sha512") => createHash(algorithm).update(readFileSync(path)).digest("base64");

async function packAndTest() {
  assert.equal(pkg.name, "memobox");
  if (process.env.EXPECTED_VERSION) assert.equal(pkg.version, process.env.EXPECTED_VERSION);
  if (!process.env.NATIVE_USE_BUILT) {
    execute(process.env.BUN_BINARY ?? "bun", ["scripts/native/build.ts"]);
    execute(process.execPath, ["scripts/native/validate.mjs"]);
  }
  execute(process.execPath, ["scripts/native/assemble.mjs", process.env.NATIVE_ARTIFACTS ?? "artifacts"], {
    env: { ...process.env, ...(!process.env.NATIVE_ALL ? { NATIVE_LOCAL_ONLY: "1" } : {}) },
  });
  const artifacts = resolve("artifacts"), stage = join(artifacts, "npm-stage");
  const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], { cwd: stage }))[0];
  assert.equal(packed.version, pkg.version); assert.equal(packed.name, pkg.name);
  assert.equal(packed.filename, `memobox-${pkg.version}.tgz`);
  for (const file of packed.files) assert(["package.json", "README.md", "README.zh-CN.md", "LICENSE", "bin/memobox.js", "bin/runtime.js", "bin/prefetch.js", "bin/manifest.json"].includes(file.path), "意外的发行文件：" + file.path);
  const tarball = join(artifacts, packed.filename); assert.equal("sha512-" + digest(tarball), packed.integrity);
  const result = await validateTarball(tarball, process.env.NATIVE_ARTIFACTS ?? "artifacts", pkg.version);
  const manifest = JSON.parse(readFileSync(join(stage, "bin/manifest.json"), "utf8"));
  writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ name: pkg.name, version: pkg.version, filename: packed.filename,
    integrity: packed.integrity, size: packed.size, revision: process.env.GITHUB_SHA ?? null, platform: process.platform,
    cliAndMcpPassed: true, platforms: Object.keys(manifest.platforms), native: result }, null, 2));
  console.log(JSON.stringify({ version: pkg.version, size: packed.size, productionDependencies: 0, installedNodeCli: "passed", twoProcessMcp: "passed", noExternalBun: true }));
}

async function publish() {
  const registry = await readRegistry();
  const plan = planRelease({ eventName: process.env.GITHUB_EVENT_NAME ?? "", ref: process.env.GITHUB_REF ?? "", repository: process.env.GITHUB_REPOSITORY ?? "",
    name: pkg.name, version: pkg.version, privatePackage: pkg.private, ...registry });
  if (!plan.publish) { console.log(plan.reason); return; }
  const directory = resolve("release"), receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"));
  assert.equal(receipt.name, pkg.name); assert.equal(receipt.version, pkg.version);
  assert.equal(receipt.revision, process.env.GITHUB_SHA); assert.equal(receipt.cliAndMcpPassed, true);
  assert.deepEqual([...receipt.platforms].sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
  assert.equal(receipt.filename, `memobox-${pkg.version}.tgz`);
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith(".tgz")), [receipt.filename]);
  const tarball = join(directory, receipt.filename);
  assert.equal("sha512-" + digest(tarball), receipt.integrity);
  // 标准 tar 仅提取 package.json 到 stdout，验证下载的制品声明。
  const artifactPkg = JSON.parse(execute("tar", ["-xOf", tarball, "package/package.json"]));
  assert.equal(artifactPkg.name, pkg.name); assert.equal(artifactPkg.version, pkg.version);
  console.log(npm(["publish", tarball, "--ignore-scripts", "--access", "public", "--tag", "latest", "--provenance"]));
  // registry 可能异步入库；核对版本和完整性，不因索引延迟再次 publish。
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(`https://registry.npmjs.org/memobox/${pkg.version}`, { signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const released = await response.json(); assert.equal(released.dist.integrity, receipt.integrity);
      assert(released.dist.attestations?.url, "npm provenance attestation missing");
      const current = await readRegistry(); assert.equal(current.latest, pkg.version);
      console.log("已发布并核对 npm latest/integrity：" + pkg.version); return;
    }
    if (response.status !== 404 && response.status !== 429 && response.status < 500) throw Error("发布后查询失败：HTTP " + response.status);
    await new Promise(done => setTimeout(done, 2000));
  }
  throw Error("npm publish 已成功，但 registry 验证超时；请查询版本，勿重复发布同版本");
}

if (process.argv[2] === "pack-and-test") await packAndTest();
else if (process.argv[2] === "publish") await publish();
else throw Error("用法：node scripts/release/package.mjs <pack-and-test|publish>");
