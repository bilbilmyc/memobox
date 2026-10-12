/** 构建时置 true；源码和测试保持 Bun + cli.ts，原生接线直接启动自身。 */
declare const MEMOBOX_COMPILED: boolean;
export const IS_COMPILED = typeof MEMOBOX_COMPILED !== "undefined" && MEMOBOX_COMPILED;
