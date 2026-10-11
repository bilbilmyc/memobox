/**
 * Codex 原生记忆迁移（v2.3）：解析 `~/.codex/memories/` 的总结文件，
 * 结构化搬进 memobox——Codex 的记忆只在 Codex 里可见，迁进来后
 * Claude Code / pi 也能检索到同一份。
 *
 * 输入两层：
 * - MEMORY.md：`# Task Group` × `## Task N`，任务带状态尾缀与 keywords
 * - memory_summary.md：`## User Profile` 蒸馏画像（整段作一条 preference）
 *
 * 总结本身 Codex 已经做完（会话结束写 rollout_summaries 再归并），
 * 这里只做零 LLM 的结构化重组，不重新生成内容。
 * id 由「组名|任务标题」哈希决定——重复导入天然幂等（已存在即跳过）。
 */
import { createHash } from "node:crypto";
import type { Memory } from "./memory-store";

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** 去掉任务标题上的状态尾缀（", success" 等），状态留在内容里 */
const STATUS_RE = /,\s*(success|partial|uncertain|failed)$/i;

/** 解析 MEMORY.md：每个 Task 一条记忆（event），keywords 进 entities */
export function parseCodexMemoryMd(text: string, now = Date.now()): Memory[] {
  const memories: Memory[] = [];
  // 按任务组切块；第一块是文件头（可能为空），跳过
  const chunks = text.split(/^# Task Group: /m).slice(1);
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    const group = lines[0].trim();
    const scope = lines
      .slice(1)
      .find((l) => /^scope:\s*(.+)$/.test(l))
      ?.replace(/^scope:\s*/, "")
      .trim();

    let task: { title: string; keywords: string[]; notes: string[] } | null = null;
    let section = ""; // 当前 ### 子节：keywords / rollout_summary_files / 其他
    const flush = () => {
      if (!task) return;
      const status = task.title.match(STATUS_RE)?.[1] ?? "";
      const title = task.title.replace(STATUS_RE, "").trim();
      const parts = [`${group} — ${title}`];
      if (status) parts.push(`[${status}]`);
      if (scope) parts.push(`范围：${scope}`);
      if (task.notes.length) parts.push(task.notes.join("；").slice(0, 300));
      memories.push({
        id: `codex-${sha(`${group}|${task.title}`)}`,
        content: parts.join("\n"),
        kind: "event",
        entities: [...new Set(task.keywords)]
          .filter((k) => k && k.length <= 40)
          .slice(0, 8),
        source: "codex",
        createdAt: now,
      });
      task = null;
    };

    for (const line of lines.slice(1)) {
      const taskMatch = line.match(/^## Task \d+: (.+)$/);
      if (taskMatch) {
        flush();
        task = { title: taskMatch[1].trim(), keywords: [], notes: [] };
        section = "";
        continue;
      }
      if (/^#{1,2} /.test(line)) {
        flush(); // 下一个任务组或其他二级标题
        continue;
      }
      const sub = line.match(/^### (.+)$/);
      if (sub) {
        section = sub[1].trim();
        continue;
      }
      if (!task) continue;
      if (section === "keywords") {
        // 形如 “- Temurin, OpenJDK, JAVA_HOME”
        const m = line.match(/^-\s+(.+)$/);
        if (m) task.keywords.push(...m[1].split(/,\s*|，/).map((k) => k.trim()));
      } else if (section !== "rollout_summary_files") {
        // 不属于引用/关键词的正文行，收作备注（回滚文件路径对检索无价值）
        const t = line.trim();
        if (t && !t.startsWith("-")) task.notes.push(t.replace(/^[-•]\s*/, ""));
      }
    }
    flush();
  }
  return memories;
}

/** 解析 memory_summary.md：User Profile 段整体作一条 preference */
export function parseCodexSummary(text: string, now = Date.now()): Memory[] {
  const m = text.match(/^## User Profile\s*\n([\s\S]*?)(?=^## |\s*$)/m);
  const content = m?.[1].trim();
  if (!content) return [];
  return [
    {
      id: "codex-user-profile",
      content: content.slice(0, 8000),
      kind: "preference",
      entities: ["user-profile"],
      source: "codex",
      createdAt: now,
    },
  ];
}
