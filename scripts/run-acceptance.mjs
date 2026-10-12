/** 同机顺序运行实际 npm 基线与候选发行物；每个模型向量来自冻结合成文本。 */
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { qualityGate, performanceGate } from "./acceptance.mjs";
import { runProcess } from "./native/process.mjs";
const root = resolve("."),
  out = resolve(process.argv[3] ?? "artifacts/acceptance"),
  binary = resolve(process.argv[2] ?? "artifacts/win32-x64/memobox.exe");
mkdirSync(out, { recursive: true });
const lookup = spawnSync(
  process.platform === "win32" ? "where.exe" : "which",
  ["bun"],
  { encoding: "utf8", windowsHide: true },
);
if (lookup.status !== 0) throw Error("Bun benchmark driver missing");
const bun = lookup.stdout.trim().split(/\r?\n/)[0],
  env = { ...process.env, BUN_BINARY: bun };
for (const key of Object.keys(env))
  if (key.startsWith("EMBEDDING_") || key === "BUN_BE_BUN") delete env[key];
const npmCli = [
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].find(existsSync);
if (!npmCli) throw Error("npm missing");
const consumer = mkdtempSync(join(tmpdir(), "memobox-baseline-"));
await runProcess(
  process.execPath,
  [
    npmCli,
    "install",
    "--prefix",
    consumer,
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "memobox@2.6.2",
  ],
  { env, timeout: 120000 },
);
const old = join(consumer, "node_modules/memobox");
if (!existsSync(join(consumer, "node_modules/@huggingface")))
  symlinkSync(
    join(root, "node_modules/@huggingface"),
    join(consumer, "node_modules/@huggingface"),
    process.platform === "win32" ? "junction" : "dir",
  );
const lock = JSON.parse(
  readFileSync(join(consumer, "package-lock.json"), "utf8"),
);
const vectors = {};
for (const pipeline of ["legacy", "current"]) {
  vectors[pipeline] = join(out, "vectors-" + pipeline + ".json");
  for (const split of ["training", "heldout"])
    await runProcess(
      bun,
      [
        "scripts/embed-fixture.ts",
        "--pipeline",
        pipeline,
        "--split",
        split,
        "--out",
        vectors[pipeline],
      ],
      { env, timeout: 240000 },
    );
  for (const split of ["training", "heldout"])
    await runProcess(
      bun,
      [
        "scripts/quality-eval.ts",
        "--split",
        split,
        "--vectors",
        vectors[pipeline],
        "--out",
        join(out, split + "-" + pipeline + ".json"),
        ...(pipeline === "legacy" ? ["--package", old] : []),
      ],
      { env, timeout: 60000 },
    );
}
const quality = qualityGate(
  JSON.parse(readFileSync(join(out, "heldout-legacy.json"), "utf8")),
  JSON.parse(readFileSync(join(out, "heldout-current.json"), "utf8")),
);
for (const pipeline of ["legacy", "current"])
  await runProcess(
    process.execPath,
    [
      "scripts/mcp-benchmark.mjs",
      ...(pipeline === "legacy" ? ["--package", old] : ["--binary", binary]),
      "--vectors",
      vectors[pipeline],
      "--out",
      join(out, "mcp-" + pipeline + ".json"),
    ],
    { env, timeout: 360000 },
  );
const performance = performanceGate(
  JSON.parse(readFileSync(join(out, "mcp-legacy.json"), "utf8")),
  JSON.parse(readFileSync(join(out, "mcp-current.json"), "utf8")),
);
const receipt = {
  baseline: {
    version: "2.6.2",
    integrity: lock.packages["node_modules/memobox"].integrity,
  },
  quality,
  performance,
  platform: process.platform,
  arch: process.arch,
};
writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
