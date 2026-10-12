/** npm 生命周期只预取平台程序，失败不阻断离线安装；提示永远走 stderr。 */
import { readFile } from "node:fs/promises";
import { ensureBinary } from "./runtime.js";
if (!process.env.MEMOBOX_SKIP_DOWNLOAD) {
  try { await ensureBinary(JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"))); }
  catch { console.error("[memobox] 平台程序尚未下载，首次运行将重试；离线安装请设置 MEMOBOX_BINARY_PATH。"); }
}
