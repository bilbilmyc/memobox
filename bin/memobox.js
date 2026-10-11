#!/usr/bin/env bun
/**
 * bin 入口壳（v2.6.1 发布用）：npm 不接受 .ts 作为 bin 脚本（发布时会被
 * 静默移除，装完没有命令），所以用这个 JS 壳交给 bun 解释，再加载真正的
 * TS 实现。仓库直跑 `bun src/cli.ts` 的老入口保持不变。
 */
import { runCli } from "../src/cli";
import { SQLiteStore } from "../src/db/sqlite-store";
import { defaultDbPath } from "../src/lib/paths";

runCli(
  process.argv.slice(2),
  { out: (s) => console.log(s), err: (s) => console.error(s) },
  // store 惰性创建：help/version/install 不该顺手建出 ~/.memobox
  () => new SQLiteStore(undefined, defaultDbPath())
)
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[memobox] fatal: ${e}`);
    process.exit(1);
  });
