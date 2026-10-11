import { describe, expect, test } from "bun:test";
import { scoreMemories, tokenize, type Memory } from "./memory";

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
