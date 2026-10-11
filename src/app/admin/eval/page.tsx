import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { memoryStore } from "@/lib/memory-store";

/**
 * 检索评测报表：query_log 的聚合视图。零召回查询是评测集的第一批
 * 候选（该召回而没召回 = 最值得人工标注的样本）；CSV 可导出离线标注。
 */
export default async function EvalPage() {
  const [stats, entities, queries] = await Promise.all([
    memoryStore.evalStats(),
    memoryStore.topEntities(15),
    memoryStore.recentQueries(50),
  ]);
  const zeroRecall = queries.filter((q) => q.recalled === 0);
  const zeroRate = stats.totalQueries
    ? Math.round((stats.zeroRecall / stats.totalQueries) * 100)
    : 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">检索评测</h1>
        <a
          href="/admin/eval/export"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          导出 CSV（最近 1000 条）
        </a>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              总查询
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{stats.totalQueries}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              零召回
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">
              {stats.zeroRecall}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                ({zeroRate}%)
              </span>
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              p50 延迟
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{stats.p50LatencyMs}ms</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              p95 延迟
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{stats.p95LatencyMs}ms</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>实体图谱 Top 15</CardTitle>
        </CardHeader>
        <CardContent>
          {entities.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              还没有实体——agent 存记忆时带 entities 标签，图谱就长出来了
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {entities.map((e) => (
                <span
                  key={e.name}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-sm"
                >
                  {e.name}
                  <span className="text-xs text-muted-foreground">
                    ×{e.memories}
                  </span>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>零召回查询（评测集候选）</CardTitle>
        </CardHeader>
        <CardContent>
          {zeroRecall.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              最近 50 条查询里没有零召回——要么检索很准，要么还没人查
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>查询</TableHead>
                  <TableHead className="w-44">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {zeroRecall.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell className="max-w-md truncate">{q.query}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(q.createdAt).toLocaleString("zh-CN")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
