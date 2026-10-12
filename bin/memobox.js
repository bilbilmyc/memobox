#!/usr/bin/env bun
/**
 * npm 的 JS 命令入口，由 Bun 加载 TS 实现。
 * 源码运行与安装包使用同一个 CLI；仍需要安装 Bun。
 */
import { runCli } from "../src/cli";
import { SQLiteStore } from "../src/db/sqlite-store";
import { defaultDbPath } from "../src/lib/paths";
import { formatCliError } from "../src/cli/presentation";

runCli(
  process.argv.slice(2),
  { out: (s) => console.log(s), err: (s) => console.error(s) },
  // store 惰性创建：help/version/install 不该顺手建出 ~/.memobox
  () => new SQLiteStore(undefined, defaultDbPath())
)
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(formatCliError(e, "启动", process.argv.includes("--debug")));
    process.exit(1);
  });
