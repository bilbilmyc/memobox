import { headers } from "next/headers";
import { memoryStore } from "@/lib/memory-store";
import { getAuth } from "@/lib/auth";
import { buildBackup } from "@/lib/backup";

/**
 * 全量备份导出（v1.6）：单 JSON 文件，含全部记忆（向量除外，可重算）。
 * 路由 handler 不走 /admin 布局的守卫，这里自己校验会话。
 */
export async function GET() {
  const { auth, ready } = getAuth();
  await ready;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return new Response("unauthorized", { status: 401 });
  }

  const backup = buildBackup(await memoryStore.exportAll());
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .slice(0, 16); // YYYY-MM-DD-HH-mm
  return new Response(JSON.stringify(backup, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="memobox-backup-${stamp}.json"`,
    },
  });
}
