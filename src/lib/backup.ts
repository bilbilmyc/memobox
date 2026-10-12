/**
 * 备份文件格式（v1.6）：单 JSON 文件，全部记忆按创建时间升序。
 * 向量刻意不进备份——它可以由 embedding 服务重算，且维度随部署配置
 * 而变（1536 锁定是 pg 部署内部约定，不代表导出目标同维度）。
 */
import type { Memory } from "./memory";
import { validateMemoryInput, MemoryValidationError, memoryValidationMessage } from "./memory-validation";

export type BackupFile = {
  format: "memobox-backup";
  version: 1;
  exportedAt: string;
  memories: Memory[];
};

/** 后台管理员是唯一受众，格式版本从这里向后兼容 */
export const BACKUP_VERSION = 1;
/** 上限防呆：管理员手滑导入超大文件时给出可读错误而不是 OOM */
export const BACKUP_MAX_ITEMS = 50000;

export function buildBackup(memories: Memory[]): BackupFile {
  return {
    format: "memobox-backup",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    memories: [...memories].sort((a, b) => a.createdAt - b.createdAt),
  };
}

type ParseResult =
  | { ok: true; items: Memory[] }
  | { ok: false; error: string };

const fail = (error: string): ParseResult => ({ ok: false, error });
const itemFail = (i: number, why: string): ParseResult =>
  fail(`第 ${i + 1} 条记忆${why}`);

/**
 * 解析并校验备份文件全文。错误信息面向后台管理员，中文即可。
 * 校验通过后返回规整过的 Memory 列表（可选字段缺省补齐）。
 */
export function parseBackup(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail("不是合法的 JSON 文件");
  }
  if (typeof data !== "object" || data === null) {
    return fail("文件内容不是一个 JSON 对象");
  }
  const obj = data as Record<string, unknown>;
  if (obj.format !== "memobox-backup") {
    return fail("不是 memobox 备份文件（缺少 format: memobox-backup 标识）");
  }
  if (obj.version !== BACKUP_VERSION) {
    return fail(`不支持的备份版本：${String(obj.version)}（当前支持 ${BACKUP_VERSION}）`);
  }
  if (!Array.isArray(obj.memories)) {
    return fail("memories 字段不是数组");
  }
  if (obj.memories.length > BACKUP_MAX_ITEMS) {
    return fail(`记忆条数 ${obj.memories.length} 超过上限 ${BACKUP_MAX_ITEMS}`);
  }

  const items: Memory[] = [];
  for (let i = 0; i < obj.memories.length; i++) {
    const raw = obj.memories[i];
    if (typeof raw !== "object" || raw === null) return itemFail(i, "不是对象");
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string" || m.id.length === 0) return itemFail(i, "缺少 id");
    if (typeof m.content !== "string" || m.content.trim().length === 0) {
      return itemFail(i, "缺少 content");
    }
    if (typeof m.createdAt !== "number" || !Number.isFinite(m.createdAt)) {
      return itemFail(i, "createdAt 不是合法时间戳");
    }
    if (
      m.entities !== undefined &&
      (!Array.isArray(m.entities) ||
        m.entities.some((e) => typeof e !== "string"))
    ) {
      return itemFail(i, "entities 不是字符串数组");
    }
    if (m.kind !== undefined && typeof m.kind !== "string") {
      return itemFail(i, "kind 不是字符串");
    }
    if (m.source !== undefined && typeof m.source !== "string") {
      return itemFail(i, "source 不是字符串");
    }
    try { validateMemoryInput(m as Memory); }
    catch (e) { if (e instanceof MemoryValidationError) return itemFail(i, memoryValidationMessage(e)); throw e; }
    items.push({
      id: m.id,
      content: m.content,
      kind: m.kind as string | undefined,
      entities: m.entities as string[] | undefined,
      source: m.source as string | undefined,
      createdAt: m.createdAt,
    });
  }
  return { ok: true, items };
}
