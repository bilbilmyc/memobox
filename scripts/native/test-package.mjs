import { readFileSync, mkdtempSync, createReadStream, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { runProcess } from "./process.mjs";
import { validateProduct } from "./validate.mjs";

export async function validateTarball(tarball, assets, expectedVersion, lite = false, registry = false) {
  const root = mkdtempSync(join(tmpdir(), "memobox-npm-native-")), consumer = join(root, "consumer");
  const npmCli = [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find(existsSync);
  if (!npmCli) throw Error("npm CLI not found");
  const installEnv = { ...process.env, HOME: root, USERPROFILE: root, MEMOBOX_BINARY_CACHE: join(root, "native-cache") };
  if (registry) for (const name of ["MEMOBOX_DOWNLOAD_BASE", "MEMOBOX_BINARY_PATH", "BUN_BE_BUN"]) delete installEnv[name];
  await runProcess(process.execPath, [npmCli, "install", "--prefix", consumer, "--cache", join(root, "npm-cache"), ...(!registry ? ["--ignore-scripts"] : []), "--omit=dev", "--no-audit", "--no-fund", registry ? `memobox@${expectedVersion}` : resolve(tarball)], { env: installEnv, timeout: 240000 });
  if (registry) {
    const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
    assert.equal(lock.packages["node_modules/memobox"].integrity, "sha512-" + createHash("sha512").update(readFileSync(tarball)).digest("base64"));
  }
  const packageRoot = join(consumer, "node_modules", "memobox"), pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(pkg.version, expectedVersion); assert.equal(pkg.dependencies, undefined); assert.equal(pkg.devDependencies, undefined); assert.equal(pkg.engines.node, ">=22");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "bin", "manifest.json"), "utf8")), platform = `${process.platform}-${process.arch}`, asset = manifest.platforms[platform];
  assert.equal(manifest.version, expectedVersion); assert(asset);
  let server;
  if (assets) {
    server = createServer((request, response) => {
      if (request.url !== "/" + asset.asset) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/gzip" }); createReadStream(join(resolve(assets), platform, asset.asset)).pipe(response);
    });
    await new Promise(done => server.listen(0, "127.0.0.1", done));
  }
  try {
    return await validateProduct(process.execPath, [join(packageRoot, "bin", "memobox.js")], { version: expectedVersion, root, lite, env: {
      ...(server ? { MEMOBOX_DOWNLOAD_BASE: `http://127.0.0.1:${server.address().port}` } : {}), MEMOBOX_BINARY_CACHE: join(root, "native-cache"),
      PATH: dirname(process.execPath) + (process.platform === "win32" ? ";" + join(process.env.SystemRoot, "System32") : ":/usr/bin:/bin"),
    } });
  } finally { if (server) await new Promise(done => server.close(done)); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = resolve(process.argv[2] ?? "release"), receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"));
  const tarball = join(directory, receipt.filename);
  assert.equal("sha512-" + createHash("sha512").update(readFileSync(tarball)).digest("base64"), receipt.integrity);
  if (process.env.GITHUB_SHA) assert.equal(receipt.revision, process.env.GITHUB_SHA);
  const publicTest = process.env.PUBLIC_RELEASE_TEST === "1";
  const result = await validateTarball(tarball, process.argv[3] ?? (publicTest ? null : "artifacts"), receipt.version, false, publicTest); console.log(JSON.stringify(result));
}
