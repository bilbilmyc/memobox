import { loadConfig } from "./config";

/** 诊断可显示来源，但 URL 凭据和查询串必须隐藏。 */
export function safeEndpoint(value: string): string {
  try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; }
  catch { return "（端点地址无效）"; }
}
export function redactDetails(value: string, additionalSecrets: string[] = []): string {
  let text = value;
  for (const secret of [...additionalSecrets, process.env.EMBEDDING_API_KEY, loadConfig().embedding?.key]) if (secret) text = text.replaceAll(secret, "[已隐藏]");
  return text.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [已隐藏]")
    .replace(/https?:\/\/[^\s'"<>]+/gi, safeEndpoint);
}
