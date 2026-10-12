import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dir, "../.."), pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const platform = `${process.platform}-${process.arch}`;
if (!["win32-x64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(platform)) throw Error("Unsupported native build platform: " + platform);
const directory = join(root, "artifacts", platform); mkdirSync(directory, { recursive: true });
const filename = process.platform === "win32" ? "memobox.exe" : "memobox", binary = join(directory, filename);
const child = Bun.spawn([process.execPath, "build", "src/cli.ts", "--compile", "--minify", "--bytecode", "--define", "MEMOBOX_COMPILED=true",
  "--external", "@huggingface/transformers", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", binary], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await child.exited) throw Error("Native compilation failed");
const bytes = readFileSync(binary), compressed = gzipSync(bytes, { level: 9 });
const asset = `memobox-${pkg.version}-${platform}.gz`; writeFileSync(join(directory, asset), compressed);
const receipt = { version: pkg.version, platform, filename, asset, sha256: createHash("sha256").update(bytes).digest("hex"),
  compressedSha256: createHash("sha256").update(compressed).digest("hex"), size: statSync(binary).size, compressedSize: compressed.byteLength, revision: process.env.GITHUB_SHA ?? null };
writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt));
