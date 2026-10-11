import { describe, expect, test } from "bun:test";
import {
  KeywordIndex,
  rrfFuse,
  scoreMemories,
  tokenize,
  type Memory,
} from "./memory";

const mem = (id: string, content: string, entities?: string[]): Memory => ({
  id,
  content,
  entities,
  createdAt: 1,
});

describe("tokenize（v2.1 CJK 切词）", () => {
  test("拉丁部分按非字母数字切开", () => {
    expect(tokenize("Port 3100 dev-server")).toEqual([
      "port",
      "3100",
      "dev-server",
    ]);
  });

  test("CJK 连续段切成 bigram；单字片段保留", () => {
    expect(tokenize("端口偏好")).toEqual(["端口", "口偏", "偏好"]);
    expect(tokenize("快")).toEqual(["快"]);
  });

  test("中英混排：CJK 段与拉丁 token 都在", () => {
    expect(tokenize("dev 用 3100 端口")).toEqual([
      "用",
      "端口",
      "dev",
      "3100",
    ]);
  });
});

describe("scoreMemories CJK", () => {
  test("整句中文查询能命中含关键词的记忆（旧实现的失效场景）", () => {
    const rows = [
      mem("a", "memobox 项目 dev 固定用 3100 端口", ["ports"]),
      mem("b", "prefer tabs over spaces", ["style"]),
    ];
    const hits = scoreMemories(rows, "端口有什么偏好", 5);
    expect(hits.map((h) => h.id)).toContain("a");
    expect(hits.map((h) => h.id)).not.toContain("b");
  });

  test("bigram 命中数排序：更相关的排前面", () => {
    const rows = [
      mem("weak", "端口偶尔提到"),
      mem("strong", "端口偏好：dev 一律 3100，偏好 Bun 运行时"),
    ];
    const hits = scoreMemories(rows, "端口偏好", 5);
    expect(hits[0].id).toBe("strong");
  });

  test("实体命中仍计分", () => {
    const rows = [mem("a", "完全无关的内容", ["端口偏好"])];
    const hits = scoreMemories(rows, "端口有什么偏好", 5);
    expect(hits.map((h) => h.id)).toContain("a");
  });

  test("纯英文行为不变", () => {
    const rows = [mem("a", "prefer tabs over spaces")];
    expect(scoreMemories(rows, "tabs", 5)).toHaveLength(1);
    expect(scoreMemories(rows, "commas", 5)).toHaveLength(0);
  });
});

describe("scoreMemories BM25（v2.5）", () => {
  test("IDF：命中稀有词的排在只命中常用词的前面", () => {
    const rows = [
      ...["a1", "a2", "a3", "a4", "a5"].map((i) => mem(i, `端口备忘 ${i}：常规内容`)),
      mem("hit", "carlife 投屏很稳"),
    ];
    // 「端口」在 5 篇都出现（IDF 低），「carlife」只有 1 篇（IDF 高）
    const hits = scoreMemories(rows, "端口 carlife", 5);
    expect(hits[0].id).toBe("hit");
  });

  test("长度归一：同样命中一次，短文档排前面", () => {
    const rows = [
      mem("long", "端口 3100 dev bun drizzle zod next react vue webpack vite eslint 一大堆别的内容"),
      mem("short", "端口 3100"),
    ];
    expect(scoreMemories(rows, "端口", 5)[0].id).toBe("short");
  });

  test("实体加成：内容同样命中时，带对应实体的排前面", () => {
    const rows = [
      mem("plain", "端口相关的内容若干"),
      mem("tagged", "端口另外的内容", ["端口"]),
    ];
    expect(scoreMemories(rows, "端口", 5)[0].id).toBe("tagged");
  });

  test("整句子串加成：完整查询串出现的文档排最前", () => {
    const rows = [
      mem("scatter", "端口 与 偏好 的 种种 讨论汇总"),
      mem("exact", "项目约定：端口偏好=3100"),
    ];
    // 两篇都命中「端口」「偏好」bigram，但只有 exact 包含整句「端口偏好」
    expect(scoreMemories(rows, "端口偏好", 5)[0].id).toBe("exact");
  });
});

describe("KeywordIndex（v2.6 全库缓存索引）", () => {
  test("增量 add/remove 维护词频统计：新词入库后 IDF 立即生效", () => {
    const idx = new KeywordIndex();
    idx.rebuild([mem("a", "端口常规"), mem("b", "端口日常")]);
    expect(idx.search("carlife", 5)).toHaveLength(0);
    idx.add(mem("c", "carlife 投屏很稳"));
    // 「端口」在 2 篇出现（IDF 低），「carlife」只有 1 篇（IDF 高）
    expect(idx.search("端口 carlife", 5)[0].id).toBe("c");
    idx.remove("c");
    expect(idx.search("carlife", 5)).toHaveLength(0);
    // remove 后词频回滚，常用词检索不受影响
    expect(idx.search("端口", 5).map((h) => h.id).sort()).toEqual(["a", "b"]);
  });

  test("重复 add 同一 id = 覆盖而非重复计数", () => {
    const idx = new KeywordIndex();
    idx.add(mem("a", "旧内容端口"));
    idx.add(mem("a", "全新内容"));
    expect(idx.search("端口", 5)).toHaveLength(0); // 旧 token 已随覆盖消失
  });
});

describe("rrfFuse（v2.6 RRF 混合融合）", () => {
  const m = (id: string, createdAt = 1): Memory => ({ id, content: id, createdAt });

  test("两路都靠前的排最前；单路命中的也能进榜", () => {
    const kw = [m("both"), m("kw-only")];
    const sem = [m("both"), m("sem-only")];
    const fused = rrfFuse([kw, sem], 3);
    expect(fused[0].id).toBe("both"); // 1/61 + 1/61
    expect([...new Set(fused.map((f) => f.id))].sort()).toEqual(
      ["both", "kw-only", "sem-only"].sort()
    );
  });

  test("limit 截断；平分按创建时间新者先", () => {
    expect(rrfFuse([[m("a", 10)], [m("b", 20)]], 1).map((f) => f.id)).toEqual([
      "b",
    ]);
  });

  test("单路为空 = 退化为另一路排名；全空 = 空结果", () => {
    expect(rrfFuse([[], [m("x"), m("y")]], 5).map((f) => f.id)).toEqual([
      "x",
      "y",
    ]);
    expect(rrfFuse([[], []], 5)).toEqual([]);
  });
});
