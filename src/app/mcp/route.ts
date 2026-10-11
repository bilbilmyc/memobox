/**
 * Memobox MCP endpoint — Streamable HTTP transport, stateless mode.
 *
 * Hand-rolled minimal JSON-RPC 2.0 (initialize / tools/list / tools/call /
 * ping) returning plain `application/json` responses, which streamable-HTTP
 * clients accept when the server offers no SSE channel. Only reach for
 * @modelcontextprotocol/sdk if we need sessions or server-initiated streams.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { memoryStore } from "@/lib/memory-store";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "memobox", version: "0.1.0" };

const saveArgs = z.object({
  content: z.string().min(1),
  kind: z.enum(["fact", "preference", "event", "decision"]).optional(),
  entities: z.array(z.string()).optional(),
  source: z.string().optional(),
});

const searchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(5),
});

const TOOLS = [
  {
    name: "memory_save",
    description:
      "Persist a memory (fact, preference, decision, event) so future sessions can recall it.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory text" },
        kind: {
          type: "string",
          enum: ["fact", "preference", "event", "decision"],
        },
        entities: {
          type: "array",
          items: { type: "string" },
          description: "Entity tags, e.g. project or people names",
        },
        source: {
          type: "string",
          description: "Who wrote this, e.g. 'claude-code'",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_search",
    description: "Search stored memories by meaning.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 5 },
      },
      required: ["query"],
    },
  },
] as const;

function rpc(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string) {
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function toolError(id: unknown, message: string) {
  // Tool failures are reported inside a successful result, per MCP.
  return rpc(id, {
    content: [{ type: "text", text: message }],
    isError: true,
  });
}

export async function POST(req: NextRequest) {
  // DNS-rebinding hygiene for a localhost service: reject foreign origins.
  const origin = req.headers.get("origin");
  if (
    origin &&
    !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    return new Response("forbidden origin", { status: 403 });
  }

  let msg: unknown;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  if (Array.isArray(msg) || typeof msg !== "object" || msg === null) {
    return rpcError(null, -32600, "invalid request");
  }

  const { id, method, params } = msg as {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };

  // Notifications (no id) get acknowledged with an empty 202.
  if (id === undefined || id === null) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case "initialize":
      return rpc(id, {
        protocolVersion:
          typeof params?.protocolVersion === "string"
            ? params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "ping":
      return rpc(id, {});

    case "tools/list":
      return rpc(id, { tools: TOOLS });

    case "tools/call": {
      const name = params?.name;
      const raw = params?.arguments ?? {};
      if (name === "memory_save") {
        const parsed = saveArgs.safeParse(raw);
        if (!parsed.success) return toolError(id, parsed.error.message);
        const row = await memoryStore.save(parsed.data);
        return rpc(id, {
          content: [
            {
              type: "text",
              text: `saved memory ${row.id}${
                row.entities?.length ? ` (entities: ${row.entities.join(", ")})` : ""
              }`,
            },
          ],
        });
      }
      if (name === "memory_search") {
        const parsed = searchArgs.safeParse(raw);
        if (!parsed.success) return toolError(id, parsed.error.message);
        const hits = await memoryStore.search(
          parsed.data.query,
          parsed.data.limit
        );
        return rpc(id, {
          content: [
            {
              type: "text",
              text: hits.length
                ? hits.map((h) => `[${h.id}] ${h.content}`).join("\n")
                : "no matching memories",
            },
          ],
        });
      }
      return toolError(id, `unknown tool: ${String(name)}`);
    }

    default:
      return rpcError(id, -32601, `unknown method: ${String(method)}`);
  }
}

export async function GET() {
  // No server-initiated SSE stream in the skeleton; POST-only JSON mode.
  return new Response("method not allowed", {
    status: 405,
    headers: { Allow: "POST" },
  });
}
