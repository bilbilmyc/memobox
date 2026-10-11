/**
 * Minimal MCP JSON-RPC 2.0 handler (Streamable HTTP, stateless, JSON
 * responses). Kept free of Next.js imports so it unit-tests cleanly;
 * src/app/mcp/route.ts is a thin adapter.
 */
import { z } from "zod";
import type { MemoryStore } from "./memory-store";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "memobox", version: "0.3.0" };

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

export const TOOLS = [
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

export type RpcResult = { status: number; body?: unknown };

const ok = (id: unknown, result: unknown): RpcResult => ({
  status: 200,
  body: { jsonrpc: "2.0", id, result },
});

const err = (id: unknown, code: number, message: string): RpcResult => ({
  status: 200,
  body: { jsonrpc: "2.0", id, error: { code, message } },
});

const toolError = (id: unknown, message: string): RpcResult =>
  ok(id, {
    content: [{ type: "text", text: message }],
    isError: true,
  });

/** Handle one raw JSON-RPC message body against the given store. */
export async function handleRpcBody(
  raw: string,
  store: MemoryStore
): Promise<RpcResult> {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return err(null, -32700, "parse error");
  }
  if (Array.isArray(msg) || typeof msg !== "object" || msg === null) {
    return err(null, -32600, "invalid request");
  }

  const { id, method, params } = msg as {
    id?: unknown;
    method?: string;
    params?: { name?: string; arguments?: unknown } & Record<string, unknown>;
  };

  // Notifications (no id) are acknowledged with an empty 202.
  if (id === undefined || id === null) {
    return { status: 202 };
  }

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion:
          typeof params?.protocolVersion === "string"
            ? params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call": {
      const name = params?.name;
      const rawArgs = params?.arguments ?? {};
      try {
        if (name === "memory_save") {
          const parsed = saveArgs.safeParse(rawArgs);
          if (!parsed.success) return toolError(id, parsed.error.message);
          const row = await store.save(parsed.data);
          return ok(id, {
            content: [
              {
                type: "text",
                text: `saved memory ${row.id}${
                  row.entities?.length
                    ? ` (entities: ${row.entities.join(", ")})`
                    : ""
                }`,
              },
            ],
          });
        }
        if (name === "memory_search") {
          const parsed = searchArgs.safeParse(rawArgs);
          if (!parsed.success) return toolError(id, parsed.error.message);
          const hits = await store.search(
            parsed.data.query,
            parsed.data.limit
          );
          return ok(id, {
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
      } catch (e) {
        // Storage backend down etc. — surfaced as a tool error, not RPC error.
        return toolError(
          id,
          `storage unavailable: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    default:
      return err(id, -32601, `unknown method: ${String(method)}`);
  }
}
