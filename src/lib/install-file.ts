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
    const heading = !multiline ? /^\s*(?:\[\[([^\]]+)\]\]|\[([^\]]+)\])\s*(?:#.*)?$/.exec(line) : null;
    if (heading) own = /^mcp_servers\.memobox(?:\.|$)/.test(heading[1] ?? heading[2]);
    if (!own) kept.push(line);
    for (let at = 0; at < line.length;) {
      if (multiline) {
        if (multiline === '"""' && line[at] === "\\") { at += 2; continue; }
        if (line.startsWith(multiline, at)) { at += 3; multiline = undefined; } else at++;
      } else {
        if (line[at] === "#") break;
        const quote = line[at];
        if (quote !== '"' && quote !== "'") { at++; continue; }
        const marker = quote.repeat(3);
        if (line.startsWith(marker, at)) { multiline = marker; at += 3; continue; }
        for (at++; at < line.length; at++) {
          if (quote === '"' && line[at] === "\\") { at++; continue; }
          if (line[at] === quote) { at++; break; }
        }
      }
    }
  }
  return kept.join("\n");
}
