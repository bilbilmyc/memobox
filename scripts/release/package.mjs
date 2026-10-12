/** 在隔离目录验证实际发行物；发布时复用已验收的 tarball，不重新打包。 */
import { spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
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

function mcpClient(entry, env) {
  const child = spawn(process.env.BUN_BINARY ?? "bun", [entry], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map(); let sequence = 0;
  const fail = (error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on("error", fail); child.on("exit", () => fail(Error("MCP 提前退出")));
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const response = JSON.parse(line), item = pending.get(response.id);
      if (!item) return;
      clearTimeout(item.timer); pending.delete(response.id);
      if (response.error || response.result?.isError) item.reject(Error("MCP 请求失败")); else item.resolve(response.result);
    } catch (error) { fail(error); }
  });
  return {
    call(method, params) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error("MCP 请求超时")); }, 10000);
        pending.set(id, { timer, resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    close() { fail(Error("测试完成")); lines.close(); child.stdin.end(); child.kill(); },
  };
}
const text = result => result.content.map(c => c.text ?? "").join("\n");

async function packAndTest() {
  assert.equal(pkg.name, "memobox");
  if (process.env.EXPECTED_VERSION) assert.equal(pkg.version, process.env.EXPECTED_VERSION);
  const artifacts = resolve("artifacts"); mkdirSync(artifacts, { recursive: true });
  const raw = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts]));
  const packed = Array.isArray(raw) ? raw[0] : raw.memobox ?? raw;
  assert.equal(packed.version, pkg.version); assert.equal(packed.name, pkg.name);
  assert.equal(packed.filename, `memobox-${pkg.version}.tgz`);
  for (const file of packed.files) {
    const name = basename(file.path);
    assert(!name.endsWith(".test.ts") && !name.startsWith(".env") && name !== "config.json" && !/\.db(?:-wal|-shm)?$/.test(name), "包中包含不应发布的文件：" + file.path);
  }
  const tarball = join(artifacts, packed.filename);
  assert.equal("sha512-" + digest(tarball), packed.integrity);
  const fixture = mkdtempSync(join(tmpdir(), "memobox-release-")), consumer = join(fixture, "consumer");
  const env = { ...process.env, MEMOBOX_DB_PATH: join(fixture, "中文共享记忆.db"), MEMOBOX_CONFIG_PATH: join(fixture, "配置.json") };
  for (const name of ["EMBEDDING_API_BASE", "EMBEDDING_API_KEY", "EMBEDDING_MODEL", "EMBEDDING_DIM", "EMBEDDING_TIMEOUT_MS", "MEMOBOX_BACKEND"]) delete env[name];
  npm(["install", "--prefix", consumer, "--cache", join(fixture, "cache"), "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", tarball]);
  const entry = join(consumer, "node_modules/memobox/bin/memobox.js");
  const cli = args => execute(process.env.BUN_BINARY ?? "bun", [entry, ...args], { env, timeout: 15000 });
  assert.equal(cli(["--version"]), pkg.version);
  assert(cli(["--help"]).includes("memobox"));
  cli(["save", "发行物验证：中文目录 ✅", "--entities", "发布项目"]);
  assert(cli(["search", "中文目录"]).includes("发行物验证"));
  const backup = join(fixture, "备份.json"); cli(["export", backup]);
  const exported = JSON.parse(readFileSync(backup, "utf8")); assert.equal(exported.memories.length, 1);
  cli(["import", backup]); assert.equal(JSON.parse(cli(["get", exported.memories[0].id])).content, exported.memories[0].content);
  const a = mcpClient(entry, env), b = mcpClient(entry, env);
  const call = (client, name, args) => client.call("tools/call", { name, arguments: args });
  try {
    for (const client of [a, b]) {
      const result = await client.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-test", version: "1" } });
      assert.equal(result.serverInfo.version, pkg.version);
      await call(client, "memory_search", { query: "release_unique_marker" });
    }
    const first = text(await call(b, "memory_save", { content: "release_unique_marker 共享记忆甲" }));
    const id = first.match(/saved memory ([\w-]+)/)?.[1]; assert(id);
    assert(text(await call(a, "memory_search", { query: "release_unique_marker" })).includes("共享记忆甲"));
    await call(a, "memory_save", { content: "release_unique_marker 共享记忆乙" });
    assert(text(await call(b, "memory_search", { query: "release_unique_marker" })).includes("共享记忆乙"));
    cli(["forget", id]);
    for (const client of [a, b]) assert(!text(await call(client, "memory_search", { query: "release_unique_marker" })).includes("共享记忆甲"));
  } finally { a.close(); b.close(); }
  writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ name: pkg.name, version: pkg.version, filename: packed.filename,
    integrity: packed.integrity, size: packed.size, revision: process.env.GITHUB_SHA ?? null, platform: process.platform, cliAndMcpPassed: true }, null, 2));
  console.log(JSON.stringify({ version: pkg.version, size: packed.size, installedCli: "passed", twoProcessMcp: "passed" }));
}

async function publish() {
  const registry = await readRegistry();
  const plan = planRelease({ eventName: process.env.GITHUB_EVENT_NAME ?? "", ref: process.env.GITHUB_REF ?? "", repository: process.env.GITHUB_REPOSITORY ?? "",
    name: pkg.name, version: pkg.version, privatePackage: pkg.private, ...registry });
  if (!plan.publish) { console.log(plan.reason); return; }
  const directory = resolve("release"), receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"));
  assert.equal(receipt.name, pkg.name); assert.equal(receipt.version, pkg.version);
  assert.equal(receipt.revision, process.env.GITHUB_SHA); assert.equal(receipt.cliAndMcpPassed, true);
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
