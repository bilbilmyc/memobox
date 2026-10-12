/**
 * 极简 MCP JSON-RPC 2.0 处理器（无状态、纯 JSON 响应）。
 * 不引任何框架依赖，方便单测；stdio 服务（src/mcp-server.ts）是薄适配层。
 */
import { z } from "zod";
import type { MemoryStore } from "./memory-store";
import { MEMORY_KINDS } from "./memory-validation";
import { VERSION } from "../version";
import { redactDetails } from "./diagnostics";
import { maintenanceInputSchema, maintenancePlanSchema } from "./maintenance";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "memobox", version: VERSION };
const nonBlank = z.string().regex(/\S/, "Must contain non-whitespace text");
const scopeShape = { kind: z.enum(MEMORY_KINDS).optional(), entity: nonBlank.optional(), source: nonBlank.optional(),
  since: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe("Created at or after this Unix timestamp in milliseconds").optional() };

const saveArgs = z.object({
  content: z.string().refine(s => Boolean(s.trim()), "Memory content must contain non-whitespace text"),
  kind: z.enum(MEMORY_KINDS).optional(),
  entities: z.array(z.string()).optional(),
  source: z.string().optional(),
});

const searchArgs = z.object({
  query: nonBlank,
  ...scopeShape,
  limit: z.number().int().min(1).max(50).default(5),
  explain: z.boolean().optional(),
}).strict();

const entitiesArgs = z.object({
  limit: z.number().int().min(1).max(100).default(20),
});

const idArgs = z.object({ id: nonBlank }).strict();
const updateArgs = z.object({ id: nonBlank, content: nonBlank.optional(), kind: z.enum(MEMORY_KINDS).optional(),
  entities: z.array(z.string()).optional(), source: nonBlank.optional() }).strict()
  .refine(v => [v.content, v.kind, v.entities, v.source].some(value => value !== undefined), "Provide at least one field to update");
const queryArgs = z.object({ text: nonBlank.optional(), ...scopeShape,
  limit: z.number().int().min(1).max(1000).default(20), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }).strict();
const memoryOutput = z.object({ id: z.string(), content: z.string(), kind: z.string().optional(), entities: z.array(z.string()).optional(), source: z.string().optional(), createdAt: z.number() });
const rankOutput = z.object({ rank: z.number().int().positive(), score: z.number() });
const explanationOutput = z.object({ mode: z.enum(["keyword", "hybrid"]),
  semantic: z.object({ status: z.enum(["disabled", "used", "unavailable", "no_matches"]), reason: z.enum(["embedding_failed", "zero_vector", "no_compatible_vectors", "below_threshold"]).optional() }),
  hits: z.array(z.object({ id: z.string(), keyword: rankOutput.optional(), semantic: rankOutput.optional(), rrfScore: z.number().optional(), graph: z.object({ entities: z.array(z.string()) }).optional() })),
});
const maintenanceScanArgs = z.object({ ...scopeShape, before: z.number().int().nonnegative().optional() }).strict();
const maintenanceApplyArgs = z.object({ plan: maintenancePlanSchema, confirm: z.literal(true) }).strict();
const maintenanceTools = [
  { name: "memory_maintenance_scan", description: "Suggest exact duplicates, possible numeric/negation conflicts and memories older than before (Unix milliseconds). Suggestions are not proof of invalid facts; nothing is modified.", args: maintenanceScanArgs, destructive: false },
  { name: "memory_maintenance_plan", description: "Preview deletion of selected IDs, or consolidate at least two memories using an agent-supplied replacement. No LLM call. First ID and creation time are retained on consolidation. Review the plan before applying.", args: maintenanceInputSchema, destructive: false },
  { name: "memory_maintenance_apply", description: "Apply an explicitly confirmed maintenance plan. Backs up originals before an atomic transaction. Rejects changed/missing targets; no partial memory changes. Returns backup path and retained ID.", args: maintenanceApplyArgs, destructive: true },
] as const;
const newTools = [
  { name: "memory_get", description: "Read one complete memory by its stable ID. Returns a memory object; missing IDs are tool errors.", args: idArgs, output: z.object({ memory: memoryOutput }), readOnly: true, destructive: false },
  { name: "memory_update", description: "Revise a memory's content, kind, entity tags or source. Preserves its ID and creation time. Supply at least one changed field; entities=[] clears tags.", args: updateArgs, output: z.object({ memory: memoryOutput }), readOnly: false, destructive: true },
  { name: "memory_forget", description: "Delete one memory by ID and its entity links. Missing IDs are tool errors. This permanently removes the memory.", args: idArgs, output: z.object({ id: z.string(), deleted: z.boolean() }), readOnly: false, destructive: true },
  { name: "memory_query", description: "Query the full memory database using AND filters and stable pagination. Text is a substring, entity a full tag, kind/source exact; since is Unix milliseconds. Does not use semantic ranking.", args: queryArgs, output: z.object({ memories: z.array(memoryOutput) }), readOnly: true, destructive: false },
] as const;

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
    description: "Search stored memories with optional AND scope filters. Entity is a full project/tag name, kind/source exact, since Unix milliseconds. Scope applies before keyword/semantic ranking and graph expansion. Set explain=true for ranks, scores, graph links and safe semantic fallback reasons.",
    inputSchema: z.toJSONSchema(searchArgs, { io: "input" }),
    outputSchema: z.toJSONSchema(z.object({ memories: z.array(memoryOutput), explanation: explanationOutput.optional() })),
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
  ...newTools.map(tool => ({ name: tool.name, description: tool.description,
    inputSchema: z.toJSONSchema(tool.args, { io: "input" }), outputSchema: z.toJSONSchema(tool.output),
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, idempotentHint: true, openWorldHint: false } })),
  ...maintenanceTools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.args, { io: "input" }),
    outputSchema: z.toJSONSchema(tool.name === "memory_maintenance_plan" ? maintenancePlanSchema : tool.name === "memory_maintenance_apply"
      ? z.object({ deleted: z.number().int().nonnegative(), updated: z.string().optional(), backup: z.string() })
      : z.object({ inspected: z.number().int().nonnegative(), duplicates: z.array(z.object({ ids: z.array(z.string()) })),
        conflicts: z.array(z.object({ ids: z.array(z.string()), reason: z.literal("possible_conflict") })), older: z.array(z.string()) })),
    annotations: { readOnlyHint: !tool.destructive, destructiveHint: tool.destructive, idempotentHint: !tool.destructive, openWorldHint: false } })),
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

/** 同时提供结构化结果和等价 JSON 文本，兼容只读取文本的客户端。 */
const structured = (id: unknown, value: Record<string, unknown>) => ok(id, {
  content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value,
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
        if (name === "memory_maintenance_scan") {
          const parsed = maintenanceScanArgs.safeParse(rawArgs); if (!parsed.success) return toolError(id, parsed.error.message);
          const { before, ...scope } = parsed.data; return structured(id, await store.scanMaintenance({ before, scope }));
        }
        if (name === "memory_maintenance_plan") {
          const parsed = maintenanceInputSchema.safeParse(rawArgs); if (!parsed.success) return toolError(id, parsed.error.message);
          return structured(id, await store.planMaintenance(parsed.data));
        }
        if (name === "memory_maintenance_apply") {
          const parsed = maintenanceApplyArgs.safeParse(rawArgs); if (!parsed.success) return toolError(id, parsed.error.message);
          return structured(id, await store.applyMaintenance(parsed.data.plan, { confirm: parsed.data.confirm }));
        }
        if (name === "memory_get" || name === "memory_forget") {
          const parsed = idArgs.safeParse(rawArgs);
          if (!parsed.success) return toolError(id, parsed.error.message);
          if (name === "memory_get") {
            const memory = await store.get(parsed.data.id);
            return memory ? structured(id, { memory }) : toolError(id, "memory not found: " + parsed.data.id);
          }
          return await store.forget(parsed.data.id) ? structured(id, { id: parsed.data.id, deleted: true }) : toolError(id, "memory not found: " + parsed.data.id);
        }
        if (name === "memory_update") {
          const parsed = updateArgs.safeParse(rawArgs);
          if (!parsed.success) return toolError(id, parsed.error.message);
          const { id: memoryId, ...patch } = parsed.data;
          const memory = await store.update(memoryId, patch);
          return memory ? structured(id, { memory }) : toolError(id, "memory not found: " + memoryId);
        }
        if (name === "memory_query") {
          const parsed = queryArgs.safeParse(rawArgs);
          if (!parsed.success) return toolError(id, parsed.error.message);
          return structured(id, { memories: await store.query(parsed.data) });
        }
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
          const { query, limit, explain, ...scope } = parsed.data;
          if (explain) return structured(id, await store.searchDetailed(query, limit, scope));
          const hits = await store.search(query, limit, scope);
          return ok(id, {
            structuredContent: { memories: hits },
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
          "storage unavailable: " + redactDetails(e instanceof Error ? e.message : String(e)).replaceAll("[已隐藏]", "[redacted]")
        );
      }
    }

    default:
      return err(id, -32601, `unknown method: ${String(method)}`);
  }
}
