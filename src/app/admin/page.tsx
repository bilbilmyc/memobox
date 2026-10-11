import Link from "next/link";
import { redirect } from "next/navigation";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { memoryStore } from "@/lib/memory-store";
import { requireAdmin } from "@/lib/auth";

/** 手动写入：人也能直接往库里存（source 标 console）。action 是独立 POST 入口，先验会话 */
async function writeMemory(formData: FormData) {
  "use server";
  await requireAdmin();
  const content = String(formData.get("content") ?? "").trim();
  if (!content) redirect("/admin?e=empty");
  const kind = String(formData.get("kind") ?? "fact");
  const entities = String(formData.get("entities") ?? "")
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  await memoryStore.save({ content, kind, entities, source: "console" });
  redirect("/admin?saved=1");
}

export default async function AdminDashboard({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; saved?: string; e?: string }>;
}) {
  await requireAdmin(); // 页面级守卫：别只信 layout（并行渲染拦不住数据块）
  const { q, saved, e } = await searchParams;
  // 检索试验走真实 search() 管线（含图谱扩展、写 query_log）——
  // 在后台试检索和 agent 实际用是同一条路径
  const hits = q?.trim() ? await memoryStore.search(q, 5) : [];
  const [{ total, searches }, recent, queries] = await Promise.all([
    memoryStore.stats(),
    memoryStore.list(20),
    memoryStore.recentQueries(10),
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
            <p className="text-3xl font-semibold">
              {memoryStore.backend === "postgres"
                ? "Postgres"
                : memoryStore.backend === "sqlite"
                  ? "SQLite"
                  : "Stub"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {memoryStore.backend === "postgres"
                ? memoryStore.retrieval === "semantic"
                  ? "pgvector 语义检索（cosine）"
                  : "关键词检索（近 500 条窗口）· 配置 EMBEDDING_API_* 升级语义检索"
                : memoryStore.backend === "sqlite"
                  ? memoryStore.retrieval === "semantic"
                    ? "本地模式 · JS 余弦语义检索"
                    : "本地模式 · 关键词检索 · 配置 EMBEDDING_API_* 升级语义检索"
                  : "内存桩（MEMOBOX_BACKEND=stub），重启即清"}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>检索试验</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form method="get" className="flex gap-2">
            <div className="flex-1">
              <Input
                name="q"
                defaultValue={q}
                placeholder="像 agent 一样检索（关键词模式中文请用短词，如「端口」）"
              />
            </div>
            <Button type="submit" variant="outline">
              检索
            </Button>
          </form>
          {q && hits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              没有召回——零召回查询会进评测页的候选清单
            </p>
          ) : null}
          {hits.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between rounded-md border px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">{m.content}</p>
                {m.entities?.length ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {m.entities.join(" · ")}
                  </p>
                ) : null}
              </div>
              <Link
                href={`/admin/memories/${m.id}`}
                className="shrink-0 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                编辑
              </Link>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>手动写入</CardTitle>
        </CardHeader>
        <CardContent>
          {saved ? (
            <p className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
              已写入。
            </p>
          ) : null}
          {e === "empty" ? (
            <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
              内容不能为空。
            </p>
          ) : null}
          <form action={writeMemory} className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="content">内容</Label>
              <Input
                id="content"
                name="content"
                required
                placeholder="直接记一条事实、偏好或决定——不必等 agent 来存"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="kind">类型</Label>
                <Input id="kind" name="kind" defaultValue="fact" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="entities">实体（逗号分隔）</Label>
                <Input id="entities" name="entities" placeholder="memobox, soren" />
              </div>
            </div>
            <div>
              <Button type="submit">写入记忆</Button>
            </div>
          </form>
        </CardContent>
      </Card>

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
                  <TableHead className="w-16">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-mono text-xs">{m.id}</TableCell>
                    <TableCell className="max-w-md">
                      <span className="block truncate">{m.content}</span>
                      {m.entities?.length ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {m.entities.join(" · ")}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>{m.kind ?? "fact"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {m.source ?? "mcp"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(m.createdAt).toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/admin/memories/${m.id}`}
                        className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      >
                        编辑
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>最近检索</CardTitle>
        </CardHeader>
        <CardContent>
          {queries.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              还没有检索记录（query_log 是评测集的原料，见决策日志）
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>查询</TableHead>
                  <TableHead className="w-20">命中</TableHead>
                  <TableHead className="w-24">延迟</TableHead>
                  <TableHead className="w-44">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queries.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell className="max-w-md truncate">{q.query}</TableCell>
                    <TableCell>{q.recalled}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {q.latencyMs == null ? "—" : `${q.latencyMs}ms`}
                    </TableCell>
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
