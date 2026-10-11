/**
 * 极简 MCP JSON-RPC 2.0 处理器（无状态、纯 JSON 响应）。
 * 不引任何框架依赖，方便单测；stdio 服务（src/mcp-server.ts）是薄适配层。
 */
import { z } from "zod";
import type { MemoryStore } from "./memory-store";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "memobox", version: "2.0.0" };

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

const entitiesArgs = z.object({
  limit: z.number().int().min(1).max(100).default(20),
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
          description:
            "Entity tags, e.g. project or people names — they power graph-linked recall",
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
  {
    name: "memory_entities",
    description:
      "List known entity tags with their memory counts — use this to see what the memory graph knows about.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 20 },
      },
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

/** 工具级错误：按 MCP 规范包在 result.content 里，isError: true */
const toolError = (id: unknown, message: string): RpcResult =>
  ok(id, {
    content: [{ type: "text", text: message }],
    isError: true,
  });

/** 处理一条原始 JSON-RPC 消息体（对给定的 store） */
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

  // 通知（无 id）：按规范回空 202
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
                  ? hits
                      .map(
                        (h) =>
                          `[${h.id}] ${h.content}${
                            h.entities?.length
                              ? ` (entities: ${h.entities.join(", ")})`
                              : ""
                          }`
                      )
                      .join("\n")
                  : "no matching memories",
              },
            ],
          });
        }
        if (name === "memory_entities") {
          const parsed = entitiesArgs.safeParse(rawArgs);
          if (!parsed.success) return toolError(id, parsed.error.message);
          const entities = await store.topEntities(parsed.data.limit);
          return ok(id, {
            content: [
              {
                type: "text",
                text: entities.length
                  ? entities.map((e) => `${e.name} (${e.memories})`).join("\n")
                  : "no entities yet",
              },
            ],
          });
        }
        return toolError(id, `unknown tool: ${String(name)}`);
      } catch (e) {
        // 存储后端挂了等情况：按工具错误返回，而不是 RPC 错误
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
