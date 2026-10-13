import { z } from "zod";
import type { MemoryStore } from "./memory";

export const feedbackArgs = z.object({
  queryId: z.string().regex(/\S/),
  memoryId: z.string().regex(/\S/),
  relevant: z.boolean().nullable().describe("true: relevant (including a missed memory); false: irrelevant returned memory; null: remove the label"),
}).strict();

export class FeedbackError extends Error {
  constructor(readonly code: "query_missing" | "memory_missing" | "not_recalled") {
    super({ query_missing: "Query not found", memory_missing: "Memory not found", not_recalled: "Irrelevant memory was not recalled by this query" }[code]);
  }
}

/** 两个入口只表达判定；引用校验、事务和幂等由同一存储实现负责。 */
export async function applyFeedback(store: MemoryStore, input: z.infer<typeof feedbackArgs>) {
  if (input.relevant === null) await store.unlabel(input.queryId, input.memoryId);
  else await store.label(input.queryId, input.memoryId, input.relevant);
  return input;
}
