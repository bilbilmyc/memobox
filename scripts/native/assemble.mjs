/** 只汇集当前提交已测试的平台包，不重新编译或修改其字节。 */
import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const root = process.cwd(), pkg = JSON.parse(readFileSync("package.json", "utf8"));
const source = resolve(process.argv[2] ?? "artifacts"), stage = resolve("artifacts/npm-stage");
const keys = process.env.NATIVE_LOCAL_ONLY ? [`${process.platform}-${process.arch}`] : ["win32-x64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const platforms = {};
for (const key of keys) {
  const directory = join(source, key), receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"));
  assert.equal(receipt.platform, key); assert.equal(receipt.version, pkg.version);
  if (process.env.GITHUB_SHA) { assert.equal(receipt.revision, process.env.GITHUB_SHA); assert.equal(receipt.nativePassed, true); }
  if (keys.length === 5) assert.equal(receipt.tests?.realLocalModelPassed, true, "All release platforms need a real local-model test");
  const asset = readFileSync(join(directory, receipt.asset));
  assert.equal(createHash("sha256").update(asset).digest("hex"), receipt.compressedSha256); assert.equal(asset.length, receipt.compressedSize);
  const { version, platform, filename, asset: assetName, sha256, compressedSha256, size, compressedSize } = receipt;
  platforms[key] = { version, platform, filename, asset: assetName, sha256, compressedSha256, size, compressedSize };
}
mkdirSync(join(stage, "bin"), { recursive: true });
for (const file of ["memobox.js", "runtime.js", "prefetch.js"]) cpSync(join(root, "bin", file), join(stage, "bin", file));
writeFileSync(join(stage, "bin", "manifest.json"), JSON.stringify({ version: pkg.version, platforms }, null, 2) + "\n");
const distribution = { ...pkg, engines: { node: ">=22" }, files: ["bin", "README.md", "README.zh-CN.md", "LICENSE"], scripts: { postinstall: "node bin/prefetch.js" } };
delete distribution.dependencies; delete distribution.devDependencies; delete distribution.packageManager;
writeFileSync(join(stage, "package.json"), JSON.stringify(distribution, null, 2) + "\n");
for (const file of ["README.md", "README.zh-CN.md", "LICENSE"]) cpSync(join(root, file), join(stage, file));
console.log(JSON.stringify({ stage, version: pkg.version, platforms: Object.keys(platforms), productionDependencies: 0 }));
