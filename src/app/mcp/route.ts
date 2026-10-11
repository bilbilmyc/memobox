/**
 * Memobox MCP endpoint — Streamable HTTP transport, stateless mode.
 * Thin adapter: origin check + JSON parsing live here, protocol logic in
 * src/lib/mcp.ts.
 */
import { NextRequest } from "next/server";
import { handleRpcBody } from "@/lib/mcp";
import { memoryStore } from "@/lib/memory-store";

export async function POST(req: NextRequest) {
  // DNS-rebinding hygiene for a localhost service: reject foreign origins.
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
  // No server-initiated SSE stream; POST-only JSON mode.
  return new Response("method not allowed", {
    status: 405,
    headers: { Allow: "POST" },
  });
}
