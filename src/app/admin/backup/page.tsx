import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { memoryStore } from "@/lib/memory-store";
import { requireAdmin } from "@/lib/auth";
import { parseBackup, BACKUP_MAX_ITEMS } from "@/lib/backup";

/** 备份文件体积上限：正常远小于此值，纯防手滑传错大文件 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** 导入备份：逐条恢复（保留原 id，冲突跳过）。action 是独立 POST 入口，先验会话 */
async function importBackup(formData: FormData) {
  "use server";
  await requireAdmin();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirect("/admin/backup?e=nofile");
  }
  if (file.size > MAX_FILE_BYTES) {
    redirect("/admin/backup?e=toobig");
  }
  const parsed = parseBackup(await file.text());
  if (!parsed.ok) {
    redirect(`/admin/backup?e=${encodeURIComponent(parsed.error)}`);
  }
  const { imported, skipped } = await memoryStore.importMemories(parsed.items);
  redirect(`/admin/backup?imported=${imported}&skipped=${skipped}`);
}

/** 备份页：导出全量 JSON / 导入恢复（SQLite↔Postgres 迁移也走这条通道） */
export default async function BackupPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string; imported?: string; skipped?: string }>;
}) {
  await requireAdmin(); // 页面级守卫：别只信 layout（并行渲染拦不住数据块）
  const { e, imported, skipped } = await searchParams;
  const { total } = await memoryStore.stats();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">备份与迁移</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          当前 {total} 条记忆。备份是单 JSON 文件（不含向量——导入时按当前
          embedding 配置重算），可用于灾备恢复，也可在 SQLite 与 Postgres
          两种模式之间整体搬家。
        </p>
      </div>

      {imported !== undefined ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          导入完成：新增 {imported} 条，跳过 {skipped ?? 0} 条（id 已存在）。
        </p>
      ) : null}
      {e === "nofile" ? <ErrorNote text="请选择一个备份文件。" /> : null}
      {e === "toobig" ? (
        <ErrorNote text={`文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限。`} />
      ) : null}
      {e && e !== "nofile" && e !== "toobig" ? (
        <ErrorNote text={`导入失败：${e}`} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>导出备份</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            全部记忆（含类型、实体、来源、创建时间）按时间升序写入一个 JSON
            文件。
          </p>
          <a href="/admin/backup/export" download>
            <Button variant="outline">下载备份 JSON</Button>
          </a>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>导入备份</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            上传备份文件恢复记忆：保留原有 id 与时间，id 已存在的条目跳过
            （不会覆盖现有数据）；上限 {BACKUP_MAX_ITEMS} 条。导入是逐条写入，
            量大时请耐心等待。
          </p>
          <form action={importBackup} className="flex items-center gap-3">
            <input
              type="file"
              name="file"
              accept="application/json,.json"
              required
              className="text-sm"
            />
            <Button type="submit">导入</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function ErrorNote({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
      {text}
    </p>
  );
}
