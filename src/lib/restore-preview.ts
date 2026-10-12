import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { Memory } from "./memory";

export type RestorePreview = { total: number; imported: number; skipped: number; conflicts: string[]; duplicateIds: string[] };

/** 默认值与 SQLite 导入一致；字段白名单忽略备份中的额外属性。 */
function comparable(memory: Memory): string {
  return JSON.stringify([memory.content, memory.kind ?? "fact", memory.source ?? "mcp", memory.entities ?? [], memory.createdAt]);
}

/** 顺序与实际导入一致：已存在或同一备份中较早出现的 id 均保留首条。 */
export function planRestore(items: Memory[], existing: Memory[]): RestorePreview {
  const seen = new Map(existing.map(memory => [memory.id, comparable(memory)]));
  const inputIds = new Set<string>(), duplicateIds = new Set<string>(), conflicts = new Set<string>();
  let imported = 0, skipped = 0;
  for (const item of items) {
    const value = comparable(item);
    if (inputIds.has(item.id)) duplicateIds.add(item.id);
    inputIds.add(item.id);
    if (seen.has(item.id)) {
      skipped++;
      if (seen.get(item.id) !== value) conflicts.add(item.id);
    } else { seen.set(item.id, value); imported++; }
  }
  return { total: items.length, imported, skipped, conflicts: [...conflicts], duplicateIds: [...duplicateIds] };
}

/** 预览专用只读连接：没有建表、迁移、向量解码或模型加载。不存在的库视为空库。 */
export function readRestoreTarget(path: string): Memory[] {
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    const statement = db.query("SELECT id, content, kind, source, entities, created_at FROM memories ORDER BY created_at, id");
    try {
      const rows = statement.all() as { id: string; content: string; kind: string; source: string; entities: string; created_at: number }[];
      return rows.map(row => ({ id: row.id, content: row.content, kind: row.kind, source: row.source, entities: JSON.parse(row.entities), createdAt: row.created_at }));
    } finally { statement.finalize(); }
  } finally { db.close(); }
}
