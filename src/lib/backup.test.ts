import { describe, expect, test } from "bun:test";
import { buildBackup, parseBackup, BACKUP_MAX_ITEMS } from "./backup";

const mem = (i: number) => ({
  id: `id-${i}`,
  content: `记忆内容 ${i}`,
  kind: "fact",
  entities: [`e${i}`],
  source: "mcp",
  createdAt: 1000 + i,
});

describe("buildBackup", () => {
  test("按创建时间升序 + 带格式标识", () => {
    const b = buildBackup([mem(2), mem(0), mem(1)]);
    expect(b.format).toBe("memobox-backup");
    expect(b.version).toBe(1);
    expect(typeof b.exportedAt).toBe("string");
    expect(b.memories.map((m) => m.id)).toEqual(["id-0", "id-1", "id-2"]);
  });

  test("round-trip：build → stringify → parse 原样回来", () => {
    const r = parseBackup(JSON.stringify(buildBackup([mem(0), mem(1)])));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toEqual([mem(0), mem(1)]);
  });
});

describe("parseBackup 校验（错误信息面向后台管理员）", () => {
  test("不是 JSON", () => {
    expect(parseBackup("{oops")).toEqual({
      ok: false,
      error: "不是合法的 JSON 文件",
    });
  });

  test("缺 format 标识", () => {
    const r = parseBackup(JSON.stringify({ version: 1, memories: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("memobox-backup");
  });

  test("版本不符", () => {
    const r = parseBackup(
      JSON.stringify({ format: "memobox-backup", version: 2, memories: [] })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("2");
  });

  test("memories 不是数组", () => {
    const r = parseBackup(
      JSON.stringify({ format: "memobox-backup", version: 1, memories: {} })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("memories");
  });

  test("条数超上限", () => {
    const r = parseBackup(
      JSON.stringify({
        format: "memobox-backup",
        version: 1,
        memories: Array(BACKUP_MAX_ITEMS + 1).fill(mem(0)),
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("超过上限");
  });

  test("第 N 条缺 content——错误带序号", () => {
    const items = [mem(0), { id: "x", createdAt: 1 }];
    const r = parseBackup(
      JSON.stringify({ format: "memobox-backup", version: 1, memories: items })
    );
    expect(r).toEqual({ ok: false, error: "第 2 条记忆缺少 content" });
  });

  test("createdAt 非数字 / entities 非字符串数组 / kind 非字符串", () => {
    const mk = (m: Record<string, unknown>) =>
      parseBackup(
        JSON.stringify({ format: "memobox-backup", version: 1, memories: [m] })
      );
    expect(mk({ id: "a", content: "c", createdAt: "2026" }).ok).toBe(false);
    expect(mk({ id: "a", content: "c", createdAt: 1, entities: [1] }).ok).toBe(
      false
    );
    expect(mk({ id: "a", content: "c", createdAt: 1, kind: 3 }).ok).toBe(false);
  });

  test("可选字段缺省可过", () => {
    const r = parseBackup(
      JSON.stringify({
        format: "memobox-backup",
        version: 1,
        memories: [{ id: "a", content: "c", createdAt: 5 }],
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items).toEqual([
        { id: "a", content: "c", createdAt: 5 },
      ]);
    }
  });
});
