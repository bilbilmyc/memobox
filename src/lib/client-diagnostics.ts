import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ClientKind } from "../install";

export type ClientDiagnostics = { client: ClientKind; configured: boolean; path: string; dbPath?: string; configPath?: string; dbMatches?: boolean;
  configMatches?: boolean; commandExists?: boolean; error?: "invalid_config" | "relative_path"; explicitDb?: boolean; explicitConfig?: boolean };
const canonical = (path: string) => { let result = existsSync(path) ? realpathSync(path) : resolve(path); if (process.platform === "win32") result = result.toLowerCase(); return result; };

/** 只读白名单字段，不把客户端其他模型、密钥和配置内容放进报告。 */
export function inspectClients(home: string, expectedDb: string, expectedConfig: string): ClientDiagnostics[] {
  return (["codex", "pi", "claude"] as const).map(client => {
    const path = client === "codex" ? join(home, ".codex", "config.toml") : client === "pi" ? join(home, ".pi", "agent", "mcp.json") : join(home, ".claude.json");
    const report: ClientDiagnostics = { client, configured: false, path };
    if (!existsSync(path)) return report;
    try {
      const raw = readFileSync(path, "utf8");
      const config = (client === "codex" ? Bun.TOML.parse(raw) : JSON.parse(raw)) as Record<string, Record<string, unknown>>;
      const entry = (config[client === "codex" ? "mcp_servers" : "mcpServers"]?.memobox) as { command?: unknown; args?: unknown; env?: Record<string, unknown> } | undefined;
      if (!entry) return report;
      report.configured = true;
      if (typeof entry.command !== "string" || !entry.command.trim() || (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== "string")))) {
        report.error = "invalid_config"; return report;
      }
      const db = entry.env?.MEMOBOX_DB_PATH, cfg = entry.env?.MEMOBOX_CONFIG_PATH;
      report.explicitDb = typeof db === "string" && Boolean(db);
      report.explicitConfig = typeof cfg === "string" && Boolean(cfg);
      report.dbPath = report.explicitDb ? db as string : join(home, ".memobox", "memobox.db");
      report.configPath = typeof cfg === "string" && cfg ? cfg : join(home, ".memobox", "config.json");
      if (!isAbsolute(report.dbPath) || !isAbsolute(report.configPath)) report.error = "relative_path";
      else { report.dbMatches = canonical(report.dbPath) === canonical(expectedDb); report.configMatches = canonical(report.configPath) === canonical(expectedConfig); }
      if (typeof entry.command === "string") report.commandExists = isAbsolute(entry.command) ? existsSync(entry.command) : Bun.which(entry.command) !== null;
    } catch { report.error = "invalid_config"; }
    return report;
  });
}
