import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { decodeEmbedding } from "../db/sqlite-store";
import { embeddingSpace, type EmbeddingProvider } from "./embeddings";
import { validateMemoryInput } from "./memory-validation";

export type DatabaseDiagnostics = {
  exists: boolean; integrity: "ok" | "not_created" | "error"; total: number; searches: number; invalidMemories: number;
  vectors: { valid: number; missing: number; invalid: number; unknownSpace: number; incompatible: number; dimensionMismatch: number };
  dimensions: number[]; foreignKeyErrors: number; legacy: boolean; error?: "unreadable_database";
};

/** 自检不经 Store 构造器：旧库不会被迁移，损坏库也能给出可解析结果。 */
export function inspectDatabase(path: string, provider: EmbeddingProvider | null): DatabaseDiagnostics {
  const report: DatabaseDiagnostics = { exists: existsSync(path), integrity: "not_created", total: 0, searches: 0, invalidMemories: 0,
    vectors: { valid: 0, missing: 0, invalid: 0, unknownSpace: 0, incompatible: 0, dimensionMismatch: 0 }, dimensions: [], foreignKeyErrors: 0, legacy: false };
  if (!report.exists) return report;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.transaction(() => {
      report.integrity = (db!.query("PRAGMA quick_check").all() as Record<string, string>[]).every(row => Object.values(row).every(value => value === "ok")) ? "ok" : "error";
      report.foreignKeyErrors = db!.query("PRAGMA foreign_key_check").all().length;
      const tables = new Set((db!.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
      if (!tables.has("memories")) throw Error("missing memories table");
      const columns = new Set((db!.query("PRAGMA table_info(memories)").all() as { name: string }[]).map(row => row.name));
      report.legacy = !columns.has("embedding_space");
      if (tables.has("query_log")) report.searches = (db!.query("SELECT count(*) AS n FROM query_log").get() as { n: number }).n;
      const dimensions = new Set<number>();
      for (const row of db!.query("SELECT * FROM memories").all() as Record<string, unknown>[]) {
        report.total++;
        try {
          validateMemoryInput({ content: row.content as string, kind: row.kind as string, entities: JSON.parse(row.entities as string) });
          if (typeof row.id !== "string" || !row.id.trim() || !Number.isSafeInteger(row.created_at)) throw Error("invalid metadata");
        } catch { report.invalidMemories++; }
        if (row.embedding == null) { report.vectors.missing++; continue; }
        const vec = decodeEmbedding(row.embedding);
        if (!vec || !vec.some(value => value !== 0)) { report.vectors.invalid++; continue; }
        dimensions.add(vec.length);
        if (provider && vec.length !== provider.dimensions) report.vectors.dimensionMismatch++;
        else if (typeof row.embedding_space !== "string" || !row.embedding_space) report.vectors.unknownSpace++;
        else if (provider && row.embedding_space !== embeddingSpace(provider, vec.length)) report.vectors.incompatible++;
        else report.vectors.valid++;
      }
      report.dimensions = [...dimensions].sort((a, b) => a - b);
    }).deferred();
  } catch { report.integrity = "error"; report.error = "unreadable_database"; }
  finally { db?.close(true); }
  return report;
}
