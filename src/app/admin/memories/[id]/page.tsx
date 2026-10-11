import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { memoryStore } from "@/lib/memory-store";

const KINDS = ["fact", "preference", "event", "decision"] as const;

/** 保存编辑：改内容会重新算 embedding，改实体会同步图谱边 */
async function saveMemory(formData: FormData) {
  "use server";
  const id = String(formData.get("id"));
  const content = String(formData.get("content") ?? "").trim();
  const kind = String(formData.get("kind") ?? "fact");
  // 逗号/顿号/空白分隔的实体标签
  const entities = String(formData.get("entities") ?? "")
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!content) redirect(`/admin/memories/${id}?e=empty`);
  await memoryStore.update(id, { content, kind, entities });
  redirect(`/admin/memories/${id}?saved=1`);
}

/** 遗忘：删除该条记忆并级联清理图谱边与孤儿实体 */
async function forgetMemory(formData: FormData) {
  "use server";
  const id = String(formData.get("id"));
  await memoryStore.forget(id);
  redirect("/admin");
}

export default async function MemoryEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; e?: string }>;
}) {
  // 双保险：布局已有 cookie 守卫，这里再校验一次写操作的前提
  const granted = (await cookies()).get("memobox_admin")?.value === "granted";
  if (!granted) redirect("/login");

  const { id } = await params;
  const { saved, e } = await searchParams;
  const memory = await memoryStore.get(id);
  if (!memory) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">编辑记忆</h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {memory.id} · 创建于 {new Date(memory.createdAt).toLocaleString("zh-CN")} ·
            来源 {memory.source ?? "mcp"}
          </p>
        </div>
        <Link
          href="/admin"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          返回总览
        </Link>
      </div>

      {saved ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          已保存。
        </p>
      ) : null}
      {e === "empty" ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          内容不能为空。
        </p>
      ) : null}

      <form action={saveMemory} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={memory.id} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="content">内容</Label>
          <textarea
            id="content"
            name="content"
            rows={5}
            required
            defaultValue={memory.content}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="kind">类型</Label>
            <select
              id="kind"
              name="kind"
              defaultValue={memory.kind ?? "fact"}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="entities">实体（图谱锚点，逗号分隔）</Label>
            <Input
              id="entities"
              name="entities"
              defaultValue={(memory.entities ?? []).join(", ")}
              placeholder="memobox, postgres, soren"
            />
          </div>
        </div>
        <div>
          <Button type="submit">保存修改</Button>
        </div>
      </form>

      <form action={forgetMemory} className="border-t pt-4">
        <input type="hidden" name="id" value={memory.id} />
        <Button type="submit" variant="destructive">
          遗忘（删除这条记忆）
        </Button>
      </form>
    </div>
  );
}
