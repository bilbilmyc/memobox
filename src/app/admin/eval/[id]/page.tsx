import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { memoryStore } from "@/lib/memory-store";
import { scoreMemories } from "@/lib/memory";

/** 标注：把某条召回记忆标为相关/无关（幂等 upsert） */
async function setLabel(formData: FormData) {
  "use server";
  const queryId = String(formData.get("queryId"));
  const memoryId = String(formData.get("memoryId"));
  const relevant = formData.get("relevant") === "1";
  await memoryStore.label(queryId, memoryId, relevant);
  redirect(`/admin/eval/${queryId}`);
}

/** 撤销一条标注 */
async function clearLabel(formData: FormData) {
  "use server";
  const queryId = String(formData.get("queryId"));
  const memoryId = String(formData.get("memoryId"));
  await memoryStore.unlabel(queryId, memoryId);
  redirect(`/admin/eval/${queryId}`);
}

/**
 * 标注视图：核对一条检索的召回结果（相关/无关），
 * 并可补充标注「漏检但相关」的记忆——它们参与 recall 分母。
 */
export default async function LabelPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { id } = await params;
  const { q } = await searchParams;
  const data = await memoryStore.getQuery(id);
  if (!data) notFound();

  const { entry, recalled, labels } = data;
  const labelByMemory = new Map(labels.map((l) => [l.memoryId, l.relevant]));
  // 补充检索：纯关键词、不写 query_log（避免标注行为污染日志）
  const searchResults = q
    ? scoreMemories(await memoryStore.list(300), q, 10).filter(
        (m) => !labelByMemory.has(m.id) && !recalled.some((r) => r.id === m.id)
      )
    : [];
  // 已补充标注但当时没被召回的相关记忆（漏检样本）
  const missedRelevant = labels
    .filter((l) => l.relevant && !recalled.some((r) => r.id === l.memoryId))
    .map((l) => l.memoryId);
  const missedMemories = (
    await Promise.all(missedRelevant.map((mid) => memoryStore.get(mid)))
  ).filter((m): m is NonNullable<typeof m> => Boolean(m));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">标注检索</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            「{entry.query}」 · 召回 {entry.recalled} 条 ·{" "}
            {entry.latencyMs == null ? "—" : `${entry.latencyMs}ms`} ·{" "}
            {new Date(entry.createdAt).toLocaleString("zh-CN")}
          </p>
        </div>
        <Link
          href="/admin/eval"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          返回评测
        </Link>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          当时召回的记忆 —— 逐条判定相关性
        </h2>
        {recalled.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            这条查询零召回——没有可判定的记忆；去下面补充标注漏检的相关记忆
          </p>
        ) : (
          recalled.map((m) => {
            const labeled = labelByMemory.get(m.id);
            return (
              <div
                key={m.id}
                className="flex flex-col gap-2 rounded-md border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{m.content}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {m.entities?.length ? `${m.entities.join(" · ")} · ` : ""}
                    {new Date(m.createdAt).toLocaleString("zh-CN")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {labeled === undefined ? (
                    <>
                      <form action={setLabel}>
                        <input type="hidden" name="queryId" value={entry.id} />
                        <input type="hidden" name="memoryId" value={m.id} />
                        <input type="hidden" name="relevant" value="1" />
                        <Button type="submit" size="sm">
                          ✓ 相关
                        </Button>
                      </form>
                      <form action={setLabel}>
                        <input type="hidden" name="queryId" value={entry.id} />
                        <input type="hidden" name="memoryId" value={m.id} />
                        <input type="hidden" name="relevant" value="0" />
                        <Button type="submit" size="sm" variant="outline">
                          ✗ 无关
                        </Button>
                      </form>
                    </>
                  ) : (
                    <>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          labeled
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {labeled ? "已标 · 相关" : "已标 · 无关"}
                      </span>
                      <form action={clearLabel}>
                        <input type="hidden" name="queryId" value={entry.id} />
                        <input type="hidden" name="memoryId" value={m.id} />
                        <Button type="submit" size="sm" variant="ghost">
                          撤销
                        </Button>
                      </form>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </section>

      {missedMemories.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            已补充的相关记忆（当时漏检，计入 recall 分母）
          </h2>
          {missedMemories.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-900 dark:bg-emerald-950"
            >
              <p className="truncate text-sm">{m.content}</p>
              <form action={clearLabel}>
                <input type="hidden" name="queryId" value={entry.id} />
                <input type="hidden" name="memoryId" value={m.id} />
                <Button type="submit" size="sm" variant="ghost">
                  撤销
                </Button>
              </form>
            </div>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-3 border-t pt-4">
        <h2 className="text-sm font-medium text-muted-foreground">
          补充标注：有相关记忆但当时没召回？搜出来标上
        </h2>
        <form method="get" className="flex gap-2">
          <div className="flex-1">
            <Input
              name="q"
              defaultValue={q}
              placeholder="关键词检索全部记忆（不会写入查询日志）"
            />
          </div>
          <Button type="submit" variant="outline">
            搜索
          </Button>
        </form>
        {q && searchResults.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有匹配的记忆。</p>
        ) : null}
        {searchResults.map((m) => (
          <div
            key={m.id}
            className="flex items-center justify-between rounded-md border border-dashed px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm">{m.content}</p>
              {m.entities?.length ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {m.entities.join(" · ")}
                </p>
              ) : null}
            </div>
            <form action={setLabel}>
              <input type="hidden" name="queryId" value={entry.id} />
              <input type="hidden" name="memoryId" value={m.id} />
              <input type="hidden" name="relevant" value="1" />
              <Button type="submit" size="sm" variant="outline">
                标为相关
              </Button>
            </form>
          </div>
        ))}
      </section>
    </div>
  );
}
