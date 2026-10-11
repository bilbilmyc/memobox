import { describe, expect, test } from "bun:test";
import { parseCodexMemoryMd, parseCodexSummary } from "./codex-import";

const MD = `# Task Group: 环境搭建

scope: 安装并验证 Windows 工具链。
applies_to: cwd=D:\\workspace

## Task 1: Install Temurin JDK 21, success

### rollout_summary_files

- rollout_summaries/x.md (cwd=x, success)

### keywords

- Temurin, OpenJDK, JAVA_HOME

## Task 2: 清理构建缓存, partial

额外备注行：只清了可重建的缓存。

### keywords

- Gradle，缓存

`;

describe("parseCodexMemoryMd", () => {
  test("每任务一条：组名+标题+状态+范围+备注，keywords 进 entities", () => {
    const items = parseCodexMemoryMd(MD, 123);
    expect(items).toHaveLength(2);
    const jdk = items[0];
    expect(jdk.content).toContain("环境搭建 — Install Temurin JDK 21");
    expect(jdk.content).toContain("[success]");
    expect(jdk.content).toContain("范围：安装并验证 Windows 工具链。");
    expect(jdk.entities).toEqual(["Temurin", "OpenJDK", "JAVA_HOME"]);
    expect(jdk.kind).toBe("event");
    expect(jdk.source).toBe("codex");
    expect(jdk.createdAt).toBe(123);

    const cache = items[1];
    expect(cache.content).toContain("[partial]");
    expect(cache.content).toContain("额外备注行");
    // 中文逗号分隔的 keywords 也能切
    expect(cache.entities).toEqual(["Gradle", "缓存"]);
  });

  test("id 由组名|标题决定——同输入同 id（幂等导入的前提）", () => {
    const a = parseCodexMemoryMd(MD);
    const b = parseCodexMemoryMd(MD);
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(a[0].id).toMatch(/^codex-[0-9a-f]{12}$/);
    // 标题含状态尾缀时，id 也稳定（原始标题参与哈希）
    expect(a[0].id).not.toBe(a[1].id);
  });

  test("无任务组的文本解析为空数组", () => {
    expect(parseCodexMemoryMd("随便一段话\n")).toEqual([]);
    expect(parseCodexMemoryMd("")).toEqual([]);
  });
});

describe("parseCodexSummary", () => {
  test("User Profile 段整体作一条 preference", () => {
    const items = parseCodexSummary(
      "# 标题\n\n## User Profile\n\n画像正文第一行。\n第二行。\n\n## User preferences\n\n- 偏好\n",
      456
    );
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("codex-user-profile");
    expect(items[0].kind).toBe("preference");
    expect(items[0].content).toContain("画像正文第一行。");
    expect(items[0].content).not.toContain("偏好"); // 不越界到下一节
    expect(items[0].createdAt).toBe(456);
  });

  test("没有画像段返回空", () => {
    expect(parseCodexSummary("## 别的\n内容\n")).toEqual([]);
  });
});
