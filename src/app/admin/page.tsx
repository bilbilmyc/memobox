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

export default async function AdminDashboard() {
  const [{ total, searches }, recent] = await Promise.all([
    memoryStore.stats(),
    memoryStore.list(20),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              记忆总数
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              累计检索
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{searches}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              存储后端
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">Stub</p>
            <p className="mt-1 text-xs text-muted-foreground">
              内存桩，重启即清——Drizzle + pgvector 接线见决策日志 v0.2
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>最近写入</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              还没有记忆。接入方式：
              <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                claude mcp add --transport http memobox http://localhost:3100/mcp
              </code>
              然后让 agent 调用 memory_save。
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">ID</TableHead>
                  <TableHead>内容</TableHead>
                  <TableHead className="w-24">类型</TableHead>
                  <TableHead className="w-32">来源</TableHead>
                  <TableHead className="w-44">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-mono text-xs">{m.id}</TableCell>
                    <TableCell className="max-w-md truncate">
                      {m.content}
                    </TableCell>
                    <TableCell>{m.kind ?? "fact"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {m.source ?? "mcp"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(m.createdAt).toLocaleString("zh-CN")}
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
