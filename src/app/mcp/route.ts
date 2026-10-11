/**
 * memobox MCP 端点 —— Streamable HTTP 传输、无状态模式。
 * 这层只做薄适配：来源校验 + 转发；协议逻辑在 src/lib/mcp.ts。
 */
import { NextRequest } from "next/server";
import { handleRpcBody } from "@/lib/mcp";
import { memoryStore } from "@/lib/memory-store";

export async function POST(req: NextRequest) {
  // 本地服务的 DNS-rebinding 防线：拒绝非本机来源的浏览器请求
  const origin = req.headers.get("origin");
  if (
    origin &&
    !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    return new Response("forbidden origin", { status: 403 });
  }

  const { status, body } = await handleRpcBody(
    await req.text(),
    memoryStore
  );
  if (status === 202) return new Response(null, { status });
  return Response.json(body, { status });
}

export async function GET() {
  // 不提供服务端主动推送的 SSE 通道：POST-only 的纯 JSON 模式
  return new Response("method not allowed", {
    status: 405,
    headers: { Allow: "POST" },
  });
}
