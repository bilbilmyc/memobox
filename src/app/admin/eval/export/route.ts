import { headers } from "next/headers";
import { memoryStore } from "@/lib/memory-store";
import { getAuth } from "@/lib/auth";

/** CSV 转义：包引号，内部引号翻倍 */
const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;

/**
 * 导出 query_log 为 CSV（最近 1000 条），供离线标注做评测集。
 * 路由 handler 不走 /admin 布局的守卫，这里自己校验会话。
 */
export async function GET() {
  const { auth, ready } = getAuth();
  await ready;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return new Response("unauthorized", { status: 401 });
  }

  const queries = await memoryStore.recentQueries(1000);
  const header = "query,recalled,latency_ms,created_at,relevant_ids";
  const lines = queries.map((q) =>
    [
      esc(q.query),
      q.recalled,
      q.latencyMs ?? "",
      new Date(q.createdAt).toISOString(),
      (q.relevantIds ?? []).join(";"),
    ].join(",")
  );
  const csv = [header, ...lines].join("\r\n");

  return new Response(`﻿${csv}`, {
    // BOM 头让 Excel 正确识别 UTF-8 中文
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="memobox-query-log.csv"',
    },
  });
}
