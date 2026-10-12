import { createHash } from "node:crypto";
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Memory, SearchScope } from "./memory";
import { matchesSearchScope } from "./memory";
import { buildBackup } from "./backup";
import { MEMORY_KINDS, validateMemoryInput } from "./memory-validation";

const nonBlank = z.string().regex(/\S/);
export const replacementSchema = z.object({ content: nonBlank, kind: z.enum(MEMORY_KINDS).optional(), entities: z.array(z.string()).optional(), source: nonBlank.optional() }).strict();
export const maintenanceInputSchema = z.object({ ids: z.array(nonBlank).min(1).max(1000), replacement: replacementSchema.optional() }).strict()
  .refine(value => new Set(value.ids).size === value.ids.length, "Duplicate target IDs")
  .refine(value => !value.replacement || value.ids.length >= 2, "Consolidation needs at least two memories");
export const maintenancePlanSchema = z.object({ format: z.literal("memobox-maintenance"), version: z.literal(1), createdAt: z.number().int().nonnegative(),
  targets: z.array(z.object({ id: nonBlank, hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(1000), replacement: replacementSchema.optional() }).strict()
  .refine(value => new Set(value.targets.map(target => target.id)).size === value.targets.length, "Duplicate target IDs")
  .refine(value => !value.replacement || value.targets.length >= 2, "Consolidation needs at least two memories");
export type MaintenanceInput = z.infer<typeof maintenanceInputSchema>;
export type MaintenancePlan = z.infer<typeof maintenancePlanSchema>;
export type MaintenanceOptions = { confirm: boolean; backupDirectory?: string };
export type MaintenanceResult = { deleted: number; updated?: string; backup: string };
export type RestoreResult = { imported: number; replaced: number; backup: string };
export type MaintenanceSuggestions = { inspected: number; duplicates: { ids: string[] }[]; conflicts: { ids: string[]; reason: "possible_conflict" }[]; older: string[] };
export type MaintenanceScan = { before?: number; scope?: SearchScope };

/** 指纹仅覆盖可恢复的内容和元数据；向量补算不使维护计划失效。 */
export function memoryFingerprint(memory: Memory): string {
  return createHash("sha256").update(JSON.stringify([memory.id, memory.content, memory.kind ?? "fact", memory.source ?? "mcp", memory.entities ?? [], memory.createdAt])).digest("hex");
}
export function createMaintenancePlan(raw: MaintenanceInput, rows: Memory[]): MaintenancePlan {
  const input = maintenanceInputSchema.parse(raw), byId = new Map(rows.map(memory => [memory.id, memory]));
  const selected = input.ids.map(id => { const memory = byId.get(id); if (!memory) throw Error("Maintenance target missing; preview again"); validateMemoryInput(memory); return memory; });
  const replacement = input.replacement ? replacementSchema.parse({ ...input.replacement, kind: input.replacement.kind ?? selected[0].kind ?? "fact", source: input.replacement.source ?? selected[0].source ?? "mcp",
    entities: input.replacement.entities ?? [...new Set(selected.flatMap(memory => memory.entities ?? []))] }) : undefined;
  return { format: "memobox-maintenance", version: 1, createdAt: Date.now(), targets: selected.map(memory => ({ id: memory.id, hash: memoryFingerprint(memory) })), ...(replacement ? { replacement } : {}) };
}
export function validateMaintenanceSnapshot(plan: MaintenancePlan, rows: Memory[]): void {
  const byId = new Map(rows.map(memory => [memory.id, memory]));
  for (const target of plan.targets) { const memory = byId.get(target.id); if (!memory || memoryFingerprint(memory) !== target.hash) throw Error("Maintenance preview is stale; preview again"); validateMemoryInput(memory); }
}
export function normalizeReplacement(replacement: NonNullable<MaintenancePlan["replacement"]>, rows: Memory[]) {
  return replacementSchema.parse({ ...replacement, kind: replacement.kind ?? rows[0].kind ?? "fact", source: replacement.source ?? rows[0].source ?? "mcp",
    entities: replacement.entities ?? [...new Set(rows.flatMap(row => row.entities ?? []))] });
}
/** 恢复和导入不同：明确覆盖选中编号，但禁止重复编号产生顺序歧义。 */
export function validateRestoreItems(items: Memory[]): void {
  if (items.length > 50000 || new Set(items.map(row => row.id)).size !== items.length) throw Error("Invalid restore batch or duplicate IDs");
  for (const row of items) {
    validateMemoryInput(row);
    if (typeof row.id !== "string" || !row.id.trim() || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0) throw Error("Invalid restore ID or timestamp");
  }
}

/** 线性分桶；只给建议，不把文字相似、年龄或旧决定当作自动删除依据。 */
export function suggestMaintenance(rows: Memory[], options: MaintenanceScan = {}): MaintenanceSuggestions {
  const selected = rows.filter(memory => matchesSearchScope(memory, options.scope ?? {})).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const duplicates = new Map<string, Memory[]>(), conflicts = new Map<string, Memory[]>();
  const normalized = (content: string) => content.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  for (const memory of selected) {
    const text = normalized(memory.content), exact = JSON.stringify([memory.kind ?? "fact", [...(memory.entities ?? [])].sort(), text]);
    const group = duplicates.get(exact) ?? []; group.push(memory); duplicates.set(exact, group);
    const skeleton = text.replace(/\d+(?:\.\d+)?/g, "<number>").replace(/\b(?:not|never|no)\b|不要|不能|禁止|不是|不/g, "").replace(/\s+/g, "");
    for (const entity of new Set(memory.entities ?? [])) {
      const key = JSON.stringify([memory.kind ?? "fact", entity.toLowerCase(), skeleton]);
      const group = conflicts.get(key) ?? []; group.push(memory); conflicts.set(key, group);
    }
  }
  const seen = new Set<string>();
  return { inspected: selected.length,
    duplicates: [...duplicates.values()].filter(group => group.length > 1).map(group => ({ ids: group.map(memory => memory.id) })),
    conflicts: [...conflicts.values()].filter(group => new Set(group.map(memory => normalized(memory.content))).size > 1).flatMap(group => {
      const ids = group.map(memory => memory.id), key = [...ids].sort().join("\0");
      if (seen.has(key)) return []; seen.add(key); return [{ ids, reason: "possible_conflict" as const }];
    }),
    older: options.before === undefined ? [] : selected.filter(memory => memory.createdAt < options.before!).reverse().map(memory => memory.id),
  };
}

/** 备份为独立不可覆盖的文件，写完并 fsync 后才允许改动数据库。 */
export function writeMaintenanceBackup(directory: string, rows: Memory[]): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `maintenance-${Date.now()}-${crypto.randomUUID()}.json`), temporary = path + ".tmp";
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600); writeFileSync(descriptor, JSON.stringify(buildBackup(rows), null, 2) + "\n", "utf8");
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined; renameSync(temporary, path); return path;
  } finally { if (descriptor !== undefined) closeSync(descriptor); if (existsSync(temporary)) unlinkSync(temporary); }
}
