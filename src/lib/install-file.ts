import { mkdirSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** 替换接线前备份完整原文件；同目录原子换入，不修改其他客户端条目。 */
export function writeInstallFile(path: string, content: string): string | undefined {
  mkdirSync(dirname(path), { recursive: true });
  const suffix = `${Date.now()}-${crypto.randomUUID()}`, temporary = `${path}.tmp-${suffix}`, backup = existsSync(path) ? `${path}.bak-${suffix}` : undefined;
  if (backup) writeFileSync(backup, readFileSync(path), { mode: 0o600, flag: "wx" });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600); writeFileSync(descriptor, content, "utf8"); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path); return backup;
  } finally { if (descriptor !== undefined) closeSync(descriptor); if (existsSync(temporary)) unlinkSync(temporary); }
}

/** 保留 TOML 的其他段落和注释；不把多行字符串里的方括号当作 section。 */
export function removeCodexSection(text: string): string {
  const lines = text.split(/\r?\n/); let own = false, multiline: string | undefined; const kept: string[] = [];
  for (const line of lines) {
    const heading = !multiline ? /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line) : null;
    if (heading) own = /^mcp_servers\.memobox(?:\.|$)/.test(heading[1]);
    if (!own) kept.push(line);
    if (!line.trimStart().startsWith("#")) for (const marker of line.match(/(?<!\\)"""|'''/g) ?? []) {
      if (!multiline) multiline = marker; else if (multiline === marker) multiline = undefined;
    }
  }
  return kept.join("\n");
}
