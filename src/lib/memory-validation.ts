/** 存储不变量：CLI、MCP、编辑和批量导入共用，校验先于任何写入。 */
export const MEMORY_KINDS = ["fact", "preference", "event", "decision"] as const;
export class MemoryValidationError extends Error {
  constructor(readonly field: "content" | "kind" | "entities") {
    super({ content: "Memory content must contain non-whitespace text", kind: "Invalid memory kind", entities: "Memory entities must be an array of strings" }[field]);
  }
}
export function memoryValidationMessage(error: MemoryValidationError): string {
  return { content: "内容不能是空白文本", kind: "类型必须是 fact、preference、event 或 decision", entities: "实体必须是字符串数组" }[error.field];
}
export function validateMemoryInput(input: { content?: string; kind?: string; entities?: string[] }, requireContent = true): void {
  if ((requireContent || input.content !== undefined) && (typeof input.content !== "string" || !input.content.trim())) throw new MemoryValidationError("content");
  if (input.kind !== undefined && !(MEMORY_KINDS as readonly string[]).includes(input.kind)) throw new MemoryValidationError("kind");
  if (input.entities !== undefined && (!Array.isArray(input.entities) || input.entities.some(e => typeof e !== "string"))) throw new MemoryValidationError("entities");
}
