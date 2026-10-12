/** 轻量 Node 分发层；存储、模型和 MCP 始终由同一原生程序实现。 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

export function platformAsset(manifest, platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`, asset = manifest.platforms[key];
  if (!asset) throw Error(`尚未支持 ${key}；支持 Windows x64、Linux/macOS x64 和 arm64。`);
  if (asset.version !== manifest.version || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^[a-f0-9]{64}$/.test(asset.compressedSha256) || !/^[a-zA-Z0-9.-]+\.gz$/.test(asset.asset)) throw Error("发行清单损坏，请重新安装 memobox。");
  return { ...asset, key };
}
export async function fileHash(path) {
  const hash = createHash("sha256"); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest("hex");
}
export async function ensureBinary(manifest, options = {}) {
  const asset = platformAsset(manifest, options.platform, options.arch), override = options.override ?? process.env.MEMOBOX_BINARY_PATH;
  if (override) {
    if ((await stat(override)).size !== asset.size || await fileHash(override) !== asset.sha256) throw Error("MEMOBOX_BINARY_PATH 与当前版本的 SHA256 不符，请用同版本官方独立包。");
    return override;
  }
  const directory = join(options.cache ?? process.env.MEMOBOX_BINARY_CACHE ?? join(homedir(), ".memobox", "bin"), manifest.version, asset.key);
  const binary = join(directory, asset.filename), receipt = join(directory, "verified.json"), lockPath = join(directory, "download.lock");
  async function cached() {
    try {
      const stored = JSON.parse(await readFile(receipt, "utf8")), info = await stat(binary);
      return stored.sha256 === asset.sha256 && info.size === asset.size && stored.mtimeMs === info.mtimeMs;
    } catch { return false; }
  }
  if (await cached()) return binary;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let lock;
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await cached()) return binary;
    try { lock = await open(lockPath, "wx", 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      // 仅清理已退出进程的锁，不能用下载耗时误判仍在工作的进程。
      try { const owner = JSON.parse(await readFile(lockPath, "utf8")); process.kill(owner.pid, 0); }
      catch (ownerError) { if (ownerError.code === "ESRCH") { await rm(lockPath, { force: true }); continue; } }
      await delay(100);
    }
  }
  if (!lock) throw Error("另一个安装进程仍在下载，请稍后重试。离线可设置 MEMOBOX_BINARY_PATH。");
  const temporary = binary + `.tmp-${process.pid}`, temporaryReceipt = receipt + `.tmp-${process.pid}`;
  try {
    if (await cached()) return binary;
    const base = options.base ?? process.env.MEMOBOX_DOWNLOAD_BASE ?? `https://github.com/bilbilmyc/memobox/releases/download/v${manifest.version}`;
    options.progress?.(`首次安装：下载 ${asset.key} 原生程序（${(asset.compressedSize / 1048576).toFixed(1)} MiB），随后离线复用。`);
    const response = await fetch(`${base.replace(/\/$/, "")}/${asset.asset}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw Error(`下载平台包失败（HTTP ${response.status}）。`);
    const compressed = createHash("sha256"), unpacked = createHash("sha256"); let compressedSize = 0, size = 0;
    const checkCompressed = new Transform({ transform(chunk, _encoding, done) { compressedSize += chunk.length; if (compressedSize > asset.compressedSize) return done(Error("平台包超过发行清单大小")); compressed.update(chunk); done(null, chunk); } });
    const checkUnpacked = new Transform({ transform(chunk, _encoding, done) { size += chunk.length; if (size > asset.size) return done(Error("平台程序超过发行清单大小")); unpacked.update(chunk); done(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), checkCompressed, createGunzip(), checkUnpacked, createWriteStream(temporary, { flags: "wx", mode: 0o700 }));
    if (size !== asset.size || compressedSize !== asset.compressedSize || compressed.digest("hex") !== asset.compressedSha256 || unpacked.digest("hex") !== asset.sha256) throw Error("平台包 SHA256 校验失败，未执行下载内容。");
    const file = await open(temporary, "r+"); try { await file.sync(); } finally { await file.close(); }
    await chmod(temporary, 0o700); await rename(temporary, binary);
    const info = await stat(binary); await writeFile(temporaryReceipt, JSON.stringify({ sha256: asset.sha256, mtimeMs: info.mtimeMs }), { flag: "wx", mode: 0o600 });
    await rename(temporaryReceipt, receipt); return binary;
  } finally {
    await rm(temporary, { force: true }); await rm(temporaryReceipt, { force: true }); await lock.close(); await rm(lockPath, { force: true });
  }
}
